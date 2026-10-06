// Host checks of the browser-side npm tree walk (net/npm-tree.js), with fixture
// registry documents in place of registry.npmjs.org.
// Run: node --test qemu-build/test-npm-tree.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpmTree, parseSpec, pickVersion, registryEdge, walkNpmTree } from './net/npm-tree.js';

const doc = (name, versions, latest = Object.keys(versions).at(-1)) => ({
  name, 'dist-tags': { latest }, modified: '2026-10-06T00:00:00Z',
  versions: Object.fromEntries(Object.entries(versions).map(([v, m]) => [v, { name, version: v, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${v}.tgz` }, ...m }])),
});

const REGISTRY = {
  app: doc('app', { '1.0.0': { dependencies: { lib: '^1.0.0', '@s/peerish': '~2.1.0', alias: 'npm:real@^3', gitdep: 'github:a/b', local: 'file:../x' }, optionalDependencies: { opt: '*' }, peerDependencies: { peer: '>=1' } } }),
  lib: doc('lib', { '1.0.0': {}, '1.2.0': { dependencies: { leaf: '1.x' } }, '1.3.0-beta.1': {}, '2.0.0': {} }, '2.0.0'),
  '@s/peerish': doc('@s/peerish', { '2.1.0': {}, '2.1.5': { dependencies: { app: '1.0.0' } }, '2.2.0': {} }),
  real: doc('real', { '3.0.0': {}, '3.1.0': { bundleDependencies: ['inside'], dependencies: { inside: '1' } } }),
  opt: doc('opt', { '0.1.0': {} }),
  peer: doc('peer', { '1.0.0': {}, '5.0.0': {} }),
  leaf: doc('leaf', { '1.0.0': {}, '1.9.9': {} }, '1.0.0'),
};

const fetchFrom = (registry, log = []) => async (name) => { log.push(name); return structuredClone(registry[name] ?? null); };

test('specs and dependency entries name registry edges, and nothing else', () => {
  assert.deepEqual(parseSpec('@scope/pkg@^1.2'), { name: '@scope/pkg', range: '^1.2' });
  assert.deepEqual(parseSpec('pkg'), { name: 'pkg', range: '' });
  assert.equal(parseSpec('../evil'), null);
  assert.deepEqual(registryEdge('x', 'npm:@a/y@2'), { name: '@a/y', range: '2' });
  for (const value of ['github:a/b', 'a/b', 'file:../x', 'git+https://x/y.git', 'https://x/y.tgz', 'workspace:*', 'link:../z'])
    assert.equal(registryEdge('x', value), null, value);
});

test('versions are picked the way npm picks them', () => {
  assert.equal(pickVersion(REGISTRY.lib, '^1.0.0'), '1.2.0', 'highest match; latest 2.0.0 does not satisfy');
  assert.equal(pickVersion(REGISTRY.leaf, '1.x'), '1.0.0', 'latest wins when it satisfies, as in npm-pick-manifest');
  assert.equal(pickVersion(REGISTRY.lib, 'latest'), '2.0.0', 'a dist-tag');
  assert.equal(pickVersion(REGISTRY.lib, ''), '2.0.0');
  assert.equal(pickVersion(REGISTRY.lib, '^9'), null);
});

test('the walk follows dependencies, optional and peer deps and aliases; trims to accepted versions', async () => {
  const log = [];
  const tree = await walkNpmTree(['app'], fetchFrom(REGISTRY, log));
  assert.deepEqual(Object.keys(tree.packuments).sort(), ['@s/peerish', 'app', 'leaf', 'lib', 'opt', 'peer', 'real']);
  assert.deepEqual(tree.missing, []);
  assert.equal(new Set(log).size, log.length, 'each document fetched once');
  assert.ok(!log.includes('inside'), 'bundled dependencies are not fetched');
  assert.deepEqual(Object.keys(tree.packuments.lib.versions).sort(), ['1.0.0', '1.2.0', '2.0.0'], '^1.0.0 matches plus latest; no prerelease');
  assert.deepEqual(Object.keys(tree.packuments['@s/peerish'].versions).sort(), ['2.1.0', '2.1.5', '2.2.0']);
  assert.equal(tree.packuments.lib['dist-tags'].latest, '2.0.0');
  assert.equal(tree.packuments.app.versions['1.0.0'].dist.tarball, 'https://registry.npmjs.org/app/-/app-1.0.0.tgz');
});

test('missing packages and unmatched ranges are reported, not fatal', async () => {
  const registry = { ...REGISTRY, app: doc('app', { '1.0.0': { dependencies: { ghost: '1', lib: '^7' } } }) };
  const tree = await walkNpmTree(['app'], fetchFrom(registry));
  assert.deepEqual(tree.missing, ['ghost', 'lib@^7']);
  assert.ok(tree.packuments.lib, 'the document still ships, so npm can report its own error');
});

test('limits hold: spec count, package count and concurrency', async () => {
  await assert.rejects(walkNpmTree([], fetchFrom(REGISTRY)), /1 to 32/);
  await assert.rejects(walkNpmTree(['../x'], fetchFrom(REGISTRY)), /not a registry package/);
  await assert.rejects(walkNpmTree(['app'], fetchFrom(REGISTRY), { limits: { specs: 32, packages: 3, concurrency: 4 } }), /exceeds 3 packages/);
  let active = 0, peak = 0;
  const wide = { root: doc('root', { '1.0.0': { dependencies: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, '1'])) } }) };
  for (let i = 0; i < 40; i++) wide[`p${i}`] = doc(`p${i}`, { '1.0.0': {} });
  await walkNpmTree(['root'], async (name) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return wide[name];
  }, { limits: { specs: 32, packages: 100, concurrency: 6 } });
  assert.ok(peak <= 6 && peak >= 4, `peak concurrency ${peak}`);
});

test('the bridge processor streams the bundle in bounded chunks', async () => {
  const requests = [];
  const fetchRemote = async (href, options) => {
    requests.push([href, options.headers.accept]);
    const name = decodeURIComponent(href.slice('https://registry.npmjs.org/'.length));
    const body = REGISTRY[name] ? JSON.stringify(REGISTRY[name]) : '{}';
    return { status: REGISTRY[name] ? 200 : 404, body: new Response(body).body };
  };
  const tree = createNpmTree({ limits: { specs: 32, packages: 100, concurrency: 4, docBytes: 1 << 20, bundleBytes: 1 << 20, chunkBytes: 64 } });
  const response = await tree.open({ npm: { specs: ['app'] } }, new AbortController(), fetchRemote);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    assert.ok(value.byteLength <= 64);
    text += new TextDecoder().decode(value);
  }
  const bundle = JSON.parse(text);
  assert.equal(bundle.format, 1);
  assert.equal(bundle.packages, 7);
  assert.ok(requests.some(([href]) => href === 'https://registry.npmjs.org/@s%2fpeerish'), 'scoped names escape their slash');
  assert.ok(requests.every(([, accept]) => accept.startsWith('application/vnd.npm.install-v1+json')), 'abbreviated documents');
  await assert.rejects(tree.open({ npm: { specs: 'app' } }, new AbortController(), fetchRemote), /invalid npm request/);
});
