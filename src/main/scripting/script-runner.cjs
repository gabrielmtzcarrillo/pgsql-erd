// Starts the script worker (src/runner/script-worker.cjs) in its own process
// and relays its requests. Independent of Electron so it can be tested with
// plain Node: in the app, the worker runs on Electron's bundled Node
// (ELECTRON_RUN_AS_NODE).
//
// The worker gets an empty environment, a memory cap, and — when the
// runtime supports Node's permission model — read access to the app's
// source only: no file writes, child processes or native addons.

const { fork } = require('node:child_process');
const path = require('node:path');

// In packaged builds the runner and the modules it loads are unpacked
// from the asar archive (see "asarUnpack" in package.json), so the child
// process reads plain files that its permission flags can allow.
const unpacked = (p) => p.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
const SRC_DIR = unpacked(path.join(__dirname, '..', '..'));
const WORKER = path.join(SRC_DIR, 'runner', 'script-worker.cjs');

let permissionFlag; // cached: '--permission', '--experimental-permission' or null

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

function defaultPermissionFlag() {
  if (permissionFlag !== undefined) return permissionFlag;
  const major = nodeMajor();
  permissionFlag = major >= 23 ? '--permission' : major >= 20 ? '--experimental-permission' : null;
  return permissionFlag;
}

function spawnWorker({ memoryMb, sandbox }) {
  const execArgv = [`--max-old-space-size=${memoryMb}`];
  const flag = sandbox ? defaultPermissionFlag() : null;
  if (flag) execArgv.push(flag, `--allow-fs-read=${SRC_DIR}${path.sep}*`, `--allow-fs-read=${SRC_DIR}`);
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // Windows needs it to start
  return fork(WORKER, [], {
    execArgv,
    env,
    cwd: SRC_DIR,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  });
}

// Runs one script. handlers.db(op, args) and handlers.ai(payload) answer the
// worker's requests; handlers.message / handlers.output receive its output
// as it happens. Resolves with { error, validations, durationMs, killed }.
function runInWorker({ code, schema, params, seedValue, limits = {}, handlers, signal }) {
  const timeoutMs = limits.timeoutMs ?? 120000;
  const memoryMb = limits.memoryMb ?? 256;

  const attempt = (sandbox) =>
    new Promise((resolve) => {
      const child = spawnWorker({ memoryMb, sandbox });
      let finished = false;
      let started = false;
      let stderr = '';
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve(result);
      };
      const timer = setTimeout(() => finish({ error: `The script took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, killed: true }), timeoutMs);
      const onAbort = () => finish({ error: 'The script was stopped.', killed: true });
      signal?.addEventListener('abort', onAbort);
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
      child.stdout.on('data', (d) => handlers.output?.(String(d).replace(/\n$/, '')));

      const reply = (id, fn) =>
        Promise.resolve()
          .then(fn)
          .then(
            (result) => !finished && child.connected && child.send({ type: 'reply', id, ok: true, result }),
            (err) => !finished && child.connected && child.send({ type: 'reply', id, ok: false, error: err.message || String(err) })
          );

      child.on('message', (msg) => {
        switch (msg?.type) {
          case 'ready':
            started = true;
            child.send({ type: 'run', code, schema, params, seedValue, limits: { maxMessages: limits.maxMessages, maxOutputChars: limits.maxOutputChars, syncTimeoutMs: Math.min(timeoutMs, 30000) } });
            break;
          case 'db':
            reply(msg.id, () => handlers.db(msg.op, msg.args));
            break;
          case 'ai':
            reply(msg.id, () => {
              if (!handlers.ai) throw new Error('AI is not available for this run.');
              return handlers.ai(msg);
            });
            break;
          case 'message':
            handlers.message?.(msg.level, msg.entry);
            break;
          case 'output':
            handlers.output?.(msg.text);
            break;
          case 'done':
            finish({ error: msg.error, validations: msg.validations, durationMs: msg.durationMs, messagesDropped: msg.messagesDropped });
            break;
          case 'failed':
            finish({ error: msg.error });
            break;
        }
      });
      child.on('error', (err) => finish({ error: `Runner error: ${err.message}`, startFailed: !started }));
      child.on('exit', (code, sig) => {
        if (finished) return;
        const oom = /heap out of memory|Allocation failed/i.test(stderr);
        finish({
          error: oom ? `The script ran out of memory (limit ${memoryMb} MB).` : `The runner exited unexpectedly (${sig ?? `code ${code}`}).${stderr ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`,
          startFailed: !started,
          killed: true,
        });
      });
    });

  return attempt(true).then((res) => {
    // If the runtime rejects the permission flags, run without them.
    if (res.startFailed && permissionFlag) {
      permissionFlag = null;
      return attempt(false);
    }
    return res;
  });
}

module.exports = { runInWorker, WORKER };
