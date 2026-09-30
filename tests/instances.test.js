// Saved PostgreSQL instances: settings on disk without passwords, passwords
// encrypted (or in memory only), the renderer view, and the last session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SavedInstances } = require('../src/main/database/saved-instances.cjs');

const crypto = {
  available: () => true,
  encrypt: (t) => Buffer.from(`enc:${[...t].reverse().join('')}`),
  decrypt: (b) => [...b.toString().replace(/^enc:/, '')].reverse().join(''),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pgerd-instances-'));
const dev = { name: 'Local dev', host: 'localhost', port: '5432', database: 'app', user: 'postgres', sslmode: 'disable', environment: 'development' };

test('saved instances keep passwords out of the config and the renderer view', () => {
  const dir = tmp();
  const m = new SavedInstances({ dir, crypto });
  assert.deepEqual(m.list().instances, []);
  const id = m.upsert(dev, 's3cret-pw');
  assert.equal(id, 'local-dev');
  assert.ok(!fs.readFileSync(path.join(dir, 'connections.json'), 'utf8').includes('s3cret-pw'));
  assert.ok(!fs.readFileSync(path.join(dir, 'connection-passwords.json'), 'utf8').includes('s3cret-pw'));
  const view = m.list();
  assert.equal(view.secureStorage, true);
  assert.equal(view.instances[0].hasPassword, true);
  assert.ok(!JSON.stringify(view).includes('s3cret-pw'));
  // A new manager (next app start) reads it back.
  const again = new SavedInstances({ dir, crypto });
  assert.deepEqual(again.resolve(id), {
    conn: { host: 'localhost', port: '5432', database: 'app', user: 'postgres', sslmode: 'disable', password: 's3cret-pw' },
    profile: { name: 'Local dev', environment: 'development', policy: undefined },
  });
});

test('updating an instance keeps, replaces or removes its password', () => {
  const m = new SavedInstances({ dir: tmp(), crypto });
  const id = m.upsert(dev, 'one');
  m.upsert({ ...dev, id, database: 'other' }, undefined);
  assert.equal(m.getPassword(id), 'one');
  assert.equal(m.get(id).database, 'other');
  m.upsert({ ...dev, id }, 'two');
  assert.equal(m.getPassword(id), 'two');
  m.upsert({ ...dev, id }, null);
  assert.equal(m.getPassword(id), null);
  assert.equal(m.list().instances.length, 1);
  // Same name, no id: a second instance with its own id.
  assert.equal(m.upsert(dev), 'local-dev-2');
});

test('without secure storage passwords stay in memory only', () => {
  const dir = tmp();
  const m = new SavedInstances({ dir, crypto: { available: () => false } });
  const id = m.upsert(dev, 'mem-only');
  assert.equal(m.getPassword(id), 'mem-only');
  assert.equal(m.list().secureStorage, false);
  assert.ok(!fs.existsSync(path.join(dir, 'connection-passwords.json')) || !fs.readFileSync(path.join(dir, 'connection-passwords.json'), 'utf8').includes('mem-only'));
  assert.equal(new SavedInstances({ dir, crypto: { available: () => false } }).getPassword(id), null);
});

test('the last session is reopened only when reconnect is on and a password is saved', () => {
  const dir = tmp();
  const m = new SavedInstances({ dir, crypto });
  const a = m.upsert(dev, 'pw');
  const b = m.upsert({ ...dev, name: 'Prod', host: 'db.example', environment: 'production' });
  m.touch(a);
  assert.equal(m.startup(), null);
  m.setReconnect(true);
  assert.equal(new SavedInstances({ dir, crypto }).startup(), a);
  m.touch(b);
  assert.equal(m.startup(), null); // no saved password for b
  assert.equal(m.list().lastId, b);
  m.remove(b);
  assert.equal(m.lastId, null);
  assert.equal(m.getPassword(b), null);
  m.remove(a);
  assert.equal(m.getPassword(a), null);
  assert.ok(!fs.readFileSync(path.join(dir, 'connection-passwords.json'), 'utf8').includes(a));
});
