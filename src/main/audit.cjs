// Audit log of operations that read or change data or share it with a
// model: schema refreshes and migrations, script runs and commits, AI
// requests (and whether they included row data), settings changes.
// One JSON object per line in <userData>/audit.log; rotated at 5 MB.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;

class AuditLog {
  constructor(file) {
    this.file = file;
  }

  log(event, details = {}) {
    const entry = { time: new Date().toISOString(), event, ...details };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      } catch {
        // no log yet
      }
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      console.error('audit log:', err.message);
    }
    return entry;
  }

  recent(limit = 200) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n');
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch {
      return [];
    }
  }
}

module.exports = { AuditLog };
