// Takes the README screenshots that need no database: starts the app with its
// own throw-away settings folder, drives it over the Chrome DevTools protocol
// and writes PNGs. See docs/screenshots.md for how each screenshot is made.
//
//   node scripts/capture-screenshots.mjs            # every shot, English and Spanish
//   node scripts/capture-screenshots.mjs ef-import  # one shot
//   node scripts/capture-screenshots.mjs --lang es  # one language
//
// Output goes to docs/screenshots/<name>.png and docs/screenshots/es/<name>.png.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const PORT = 9333;
const SIZE = { width: 1440, height: 880 };

const args = process.argv.slice(2);
const langArg = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');

// ---------------------------------------------------------------- shots

// Each shot gets the page's `cdp` helpers: eval(js), wait(ms), shot(file).
const SHOTS = {
  // Drop the example DbContext on the window: the import dialog opens with the tables read from it.
  async 'ef-import'({ eval: run, wait, shot }) {
    const text = readFileSync(path.join(root, 'docs/examples/ShopContext.cs'), 'utf8');
    await run(`(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(text)}], 'ShopContext.cs', { type: 'text/plain' }));
      document.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await wait(800);
    await shot('ef-import.png');
  },
};

// ---------------------------------------------------------------- CDP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('The app did not open a window');
}

async function session(ws) {
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 1, mobile: false });
  return send;
}

async function run(lang) {
  const data = mkdtempSync(path.join(tmpdir(), 'pgsql-erd-shots-'));
  writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ locale: lang, theme: 'white' }));
  const app = spawn(electron, [root, `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], { stdio: 'ignore' });
  try {
    const ws = await connect();
    const send = await session(ws);
    await sleep(1500);
    const outDir = path.join(root, 'docs/screenshots', lang === 'en' ? '' : lang);
    mkdirSync(outDir, { recursive: true });
    const helpers = {
      eval: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      wait: sleep,
      shot: async (file) => {
        const { data: b64 } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path.join(outDir, file), Buffer.from(b64, 'base64'));
        console.log(`wrote ${path.relative(root, path.join(outDir, file))}`);
      },
    };
    for (const [name, fn] of Object.entries(SHOTS)) {
      if (wanted.length && !wanted.includes(name)) continue;
      await fn(helpers);
    }
    ws.close();
  } finally {
    app.kill();
    await sleep(500);
    rmSync(data, { recursive: true, force: true });
  }
}

for (const lang of langArg ? [langArg] : ['en', 'es']) await run(lang);
