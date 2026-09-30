// Projects on disk. A project is the folder that holds a diagram (.pgerd):
//
//   project/
//   ├── diagram.pgerd
//   ├── pgsql-erd.json          project settings (no secrets)
//   ├── scripts/
//   │   ├── validators/*.ts
//   │   ├── generators/*.ts
//   │   └── …
//   └── generated/database.d.ts typings for editors outside the app
//
// Everything is plain text so it works with version control. Database
// passwords and API keys are never written here.

const fs = require('node:fs/promises');
const path = require('node:path');

const SETTINGS_FILE = 'pgsql-erd.json';

class ProjectManager {
  constructor({ shared }) {
    this.shared = shared;
    this.projects = new Map(); // windowId -> dir
  }

  set(windowId, diagramPath) {
    if (diagramPath) this.projects.set(windowId, path.dirname(diagramPath));
    else this.projects.delete(windowId);
    return this.projects.get(windowId) ?? null;
  }

  dir(windowId) {
    return this.projects.get(windowId) ?? null;
  }

  require(windowId) {
    const d = this.dir(windowId);
    if (!d) throw new Error('Save the diagram first: scripts are stored in a scripts/ folder next to it.');
    return d;
  }

  // Resolve a project-relative script path, refusing anything outside scripts/.
  resolve(dir, rel) {
    const scripts = path.join(dir, 'scripts');
    const full = path.resolve(dir, String(rel));
    if (!full.startsWith(scripts + path.sep) || !full.endsWith('.ts')) throw new Error(`Not a script path: ${rel}`);
    return full;
  }

  async listScripts(windowId) {
    const dir = this.dir(windowId);
    if (!dir) return [];
    const root = path.join(dir, 'scripts');
    const out = [];
    let folders;
    try {
      folders = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const f of folders) {
      if (!f.isDirectory()) continue;
      const fallback = this.shared.typeForFolder(f.name);
      let files;
      try {
        files = await fs.readdir(path.join(root, f.name));
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const full = path.join(root, f.name, name);
        try {
          const [text, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
          const meta = this.shared.parseScriptFile(text, fallback);
          out.push({
            path: path.relative(dir, full).split(path.sep).join('/'),
            name: name.replace(/\.ts$/, ''),
            type: meta.type,
            profile: meta.profile,
            description: meta.description,
            tables: meta.tables,
            // For linking scripts to diagram tables; very large files are left out.
            source: meta.source.length <= 200000 ? meta.source : '',
            modified: stat.mtimeMs,
          });
        } catch {
          // unreadable file: skip
        }
      }
    }
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  async readScript(windowId, rel) {
    const dir = this.require(windowId);
    const full = this.resolve(dir, rel);
    const text = await fs.readFile(full, 'utf8');
    const folder = path.basename(path.dirname(full));
    return { path: rel, name: path.basename(full, '.ts'), ...this.shared.parseScriptFile(text, this.shared.typeForFolder(folder)) };
  }

  // script: { path?, name, type, profile, overrides, description, tables, source }
  // Without a path (new script) one is chosen from the type and name; an
  // existing file is not overwritten unless `overwrite` is set.
  async writeScript(windowId, script, { overwrite = false } = {}) {
    const dir = this.require(windowId);
    let rel = script.path;
    if (!rel) {
      rel = this.shared.scriptPath(script.type, script.name);
      for (let i = 2; await exists(this.resolve(dir, rel)); i++) rel = this.shared.scriptPath(script.type, `${script.name}-${i}`);
    } else if (!overwrite && script.isNew && (await exists(this.resolve(dir, rel)))) {
      throw new Error(`${rel} already exists.`);
    }
    const full = this.resolve(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, this.shared.serializeScriptFile(script), 'utf8');
    return rel;
  }

  // Rename or move (type change) a script; returns the new path.
  async moveScript(windowId, rel, type, name) {
    const dir = this.require(windowId);
    const from = this.resolve(dir, rel);
    let to = this.shared.scriptPath(type, name);
    if (this.resolve(dir, to) === from) return rel;
    for (let i = 2; await exists(this.resolve(dir, to)); i++) to = this.shared.scriptPath(type, `${name}-${i}`);
    await fs.mkdir(path.dirname(this.resolve(dir, to)), { recursive: true });
    await fs.rename(from, this.resolve(dir, to));
    return to;
  }

  async deleteScript(windowId, rel) {
    const dir = this.require(windowId);
    await fs.unlink(this.resolve(dir, rel));
  }

  async settings(windowId) {
    const dir = this.dir(windowId);
    if (!dir) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  async saveSettings(windowId, settings) {
    const dir = this.require(windowId);
    const current = (await this.settings(windowId)) ?? { version: 1 };
    const next = { ...current, ...strip(settings), version: 1 };
    await fs.writeFile(path.join(dir, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  // Keep generated/database.d.ts in sync, but only in projects that
  // already have scripts (don't litter folders that just hold a diagram).
  async writeTypes(windowId, dts) {
    const dir = this.dir(windowId);
    if (!dir || !(await exists(path.join(dir, 'scripts')))) return null;
    const file = path.join(dir, 'generated', 'database.d.ts');
    try {
      if ((await fs.readFile(file, 'utf8')) === dts) return file;
    } catch {
      // not written yet
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, dts, 'utf8');
    return file;
  }
}

// Settings never carry secrets, whatever the renderer sends.
function strip(settings) {
  const out = JSON.parse(JSON.stringify(settings ?? {}));
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (/(password|apiKey|api_key|secret|token)/i.test(k)) delete o[k];
      else walk(o[k]);
    }
  };
  walk(out);
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ProjectManager, SETTINGS_FILE };
