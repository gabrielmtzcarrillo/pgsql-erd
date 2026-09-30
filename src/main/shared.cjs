// Loads the ES modules in src/shared (also used by the renderer) into the
// CommonJS main process. Resolved once and cached.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'shared');
const MODULES = ['schema-model', 'typegen', 'permissions', 'scripts', 'json-schema', 'context-builder', 'fake', 'seed'];

let loading = null;

function loadShared() {
  loading ??= Promise.all(MODULES.map((m) => import(pathToFileURL(path.join(dir, `${m}.js`)).href))).then((mods) =>
    Object.assign({}, ...mods)
  );
  return loading;
}

module.exports = { loadShared, sharedDir: dir };
