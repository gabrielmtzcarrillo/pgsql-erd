// Saved PostgreSQL instances (independent of projects) and their passwords.
//
// Instances are stored in <userData>/connections.json without secrets:
//   { "instances": [{ "id": "local-dev", "name": "Local dev", "host": "localhost", "port": "5432",
//                     "database": "app", "user": "postgres", "sslmode": "disable",
//                     "environment": "development", "policy": { ... }, "lastUsedAt": 0 }],
//     "lastId": "local-dev", "reconnect": false }
// Passwords are encrypted with the operating system's credential store
// (Electron safeStorage: Keychain, DPAPI, libsecret/kwallet) into
// <userData>/connection-passwords.json. When no secure store is available
// passwords are kept in memory for the session only. Passwords never leave
// the main process.

const fs = require('node:fs');
const path = require('node:path');

const FIELDS = ['host', 'port', 'database', 'user', 'sslmode'];
const SSLMODES = ['disable', 'require', 'verify-full'];

// crypto: { available(): boolean, encrypt(text): Buffer, decrypt(Buffer): string }
class SavedInstances {
  constructor({ dir, crypto = null }) {
    this.dir = dir;
    this.crypto = crypto;
    this.memoryPasswords = new Map();
    const j = this.load();
    this.instances = j.instances;
    this.lastId = j.lastId;
    this.reconnect = j.reconnect;
  }

  get configFile() {
    return path.join(this.dir, 'connections.json');
  }

  get passwordsFile() {
    return path.join(this.dir, 'connection-passwords.json');
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      const instances = Array.isArray(j.instances) ? j.instances.filter((i) => i?.id).map(clean) : [];
      return {
        instances,
        lastId: instances.some((i) => i.id === j.lastId) ? j.lastId : null,
        reconnect: !!j.reconnect,
      };
    } catch {
      // first run or unreadable: nothing saved yet
      return { instances: [], lastId: null, reconnect: false };
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const j = { instances: this.instances, lastId: this.lastId, reconnect: this.reconnect };
    fs.writeFileSync(this.configFile, `${JSON.stringify(j, null, 2)}\n`, { mode: 0o600 });
  }

  secureStorage() {
    return !!this.crypto?.available();
  }

  readPasswords() {
    try {
      return JSON.parse(fs.readFileSync(this.passwordsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  getPassword(id) {
    if (this.memoryPasswords.has(id)) return this.memoryPasswords.get(id);
    const stored = this.readPasswords()[id];
    if (stored && this.secureStorage()) {
      try {
        return this.crypto.decrypt(Buffer.from(stored, 'base64'));
      } catch {
        return null;
      }
    }
    return null;
  }

  // password: string to store, '' or null to remove.
  setPassword(id, password) {
    const passwords = this.readPasswords();
    const had = id in passwords;
    this.memoryPasswords.delete(id);
    delete passwords[id];
    if (password) {
      if (this.secureStorage()) passwords[id] = this.crypto.encrypt(password).toString('base64');
      else this.memoryPasswords.set(id, password);
    }
    if (!had && !(id in passwords)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.passwordsFile, `${JSON.stringify(passwords, null, 2)}\n`, { mode: 0o600 });
  }

  // What the renderer may see: no passwords, only whether one is saved.
  list() {
    return {
      secureStorage: this.secureStorage(),
      lastId: this.lastId,
      reconnect: this.reconnect,
      instances: [...this.instances]
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name))
        .map((i) => ({ ...i, hasPassword: !!this.getPassword(i.id) })),
    };
  }

  get(id) {
    return this.instances.find((i) => i.id === id) ?? null;
  }

  // The connection settings with the saved password, for connecting.
  resolve(id) {
    const i = this.get(id);
    if (!i) throw new Error(`Unknown saved instance: ${id || '(none)'}`);
    const conn = Object.fromEntries(FIELDS.map((k) => [k, i[k]]));
    return { conn: { ...conn, password: this.getPassword(id) ?? '' }, profile: { name: i.name, environment: i.environment, policy: i.policy } };
  }

  // instance: { id?, name, host, port, database, user, sslmode, environment, policy }
  // password: string to store, '' or null to remove, undefined to keep.
  upsert(instance, password) {
    const i = clean(instance);
    if (!i.name) i.name = describe(i);
    if (!i.id || !this.get(i.id)) i.id = uniqueId(this.instances, i.name);
    const at = this.instances.findIndex((x) => x.id === i.id);
    if (at === -1) this.instances.push(i);
    else this.instances[at] = { ...i, lastUsedAt: i.lastUsedAt ?? this.instances[at].lastUsedAt };
    this.save();
    if (password !== undefined) this.setPassword(i.id, password);
    return i.id;
  }

  remove(id) {
    this.instances = this.instances.filter((i) => i.id !== id);
    if (this.lastId === id) this.lastId = null;
    this.save();
    this.setPassword(id, null);
  }

  // Marks the instance as the last session, reopened on startup when
  // reconnect is on.
  touch(id) {
    const i = this.get(id);
    if (!i) return;
    i.lastUsedAt = Date.now();
    this.lastId = id;
    this.save();
  }

  setReconnect(on) {
    this.reconnect = !!on;
    this.save();
  }

  // The instance to reopen when a window starts, or null.
  startup() {
    if (!this.reconnect || !this.lastId) return null;
    return this.get(this.lastId) && this.getPassword(this.lastId) ? this.lastId : null;
  }
}

function describe(c) {
  return `${c.user || 'postgres'}@${c.host || 'localhost'}:${c.port || 5432}/${c.database || 'postgres'}`;
}

function clean(i) {
  const out = { id: String(i.id ?? '').trim(), name: String(i.name ?? '').trim() };
  for (const k of FIELDS) out[k] = String(i[k] ?? '').trim();
  if (!SSLMODES.includes(out.sslmode)) out.sslmode = 'disable';
  out.environment = String(i.environment ?? 'development');
  if (i.policy && typeof i.policy === 'object') out.policy = { allowWrites: !!i.policy.allowWrites, allowDDL: !!i.policy.allowDDL };
  if (Number.isFinite(i.lastUsedAt)) out.lastUsedAt = i.lastUsedAt;
  return out;
}

function uniqueId(list, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'instance';
  let id = base;
  for (let i = 2; list.some((x) => x.id === id); i++) id = `${base}-${i}`;
  return id;
}

module.exports = { SavedInstances };
