/* The service worker precaches a hand-written list. Nothing else notices when a
 * new file is added and the list is not updated — the app just silently stops
 * working offline. These checks fail instead. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFile(join(root, f), 'utf8');

const swAssets = async () => {
  const sw = await read('sw.js');
  const list = /var ASSETS = \[([\s\S]*?)\]/.exec(sw);
  assert.ok(list, 'sw.js declares an ASSETS array');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

test('every precached asset exists on disk', async () => {
  for (const a of await swAssets()) {
    if (a === '.') continue;
    await assert.doesNotReject(access(join(root, a)), a + ' is precached but missing');
  }
});

test('every local file index.html references is precached', async () => {
  const html = await read('index.html');
  const assets = await swAssets();
  const refs = [...html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 3, 'found references to check');
  for (const r of refs) {
    assert.ok(assets.includes(r), r + ' is referenced by index.html but not in sw.js ASSETS');
  }
});

test('every module core.js is imported from is precached', async () => {
  const app = await read('app.js');
  const assets = await swAssets();
  for (const m of [...app.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1])) {
    assert.ok(assets.includes(m), m + ' is imported by app.js but not in sw.js ASSETS');
  }
});

test('the manifest icons exist', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  for (const icon of manifest.icons || []) {
    await assert.doesNotReject(access(join(root, icon.src)), icon.src + ' is missing');
  }
});

test('the cache version was bumped alongside the asset list', async () => {
  const sw = await read('sw.js');
  const v = /var CACHE = 'plankmatrix-v(\d+)'/.exec(sw);
  assert.ok(v, 'sw.js declares a versioned cache name');
  assert.ok(+v[1] >= 4, 'cache version keeps moving forward');
});
