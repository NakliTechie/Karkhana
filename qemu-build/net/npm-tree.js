// npm dependency trees walked in the browser, outside the emulated guest CPU.
// npm resolves one registry document at a time, and each guest request costs
// about a second; knpm asks the page for the whole tree up front instead. The
// page fetches documents many at a time, picks versions the way npm does
// (dist-tag latest when it satisfies the range, else the highest match), and
// returns one bundle trimmed to the versions any range in the tree accepts.
// Anything the walk misses, knpm fetches on demand, so a wrong guess costs
// time, never correctness.
import { maxSatisfying, satisfies, validRange } from './semver.mjs';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_LIMITS = Object.freeze({ specs: 32, packages: 4000, concurrency: 24,
  docBytes: 64 * 1024 * 1024, bundleBytes: 128 * 1024 * 1024, chunkBytes: 1024 * 1024 });
// npm's abbreviated ("corgi") documents carry what installs need, at a fraction of the size.
export const CORGI = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const NAME = /^(?:@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/;
const encoder = new TextEncoder();
const failure = (message, code = 'network') => Object.assign(new Error(message), { code });

// 'pkg', 'pkg@range', '@scope/pkg@range' -> { name, range }; null when the
// name is not a registry package name.
export function parseSpec(spec) {
  if (typeof spec !== 'string' || spec.length > 512) return null;
  const at = spec.indexOf('@', 1);
  const name = at === -1 ? spec : spec.slice(0, at);
  const range = at === -1 ? '' : spec.slice(at + 1);
  return NAME.test(name) && name.length <= 214 ? { name, range } : null;
}

// A dependency entry -> the registry edge it names, or null for git, file,
// URL and workspace dependencies, which never touch the registry.
export function registryEdge(name, value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('npm:')) return parseSpec(value.slice(4));
  if (/^(?:[a-z+]+:|\.{0,2}\/|~\/)/i.test(value) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) return null;
  return NAME.test(name) ? { name, range: value.trim() } : null;
}

// The version npm would pick for one range of one document.
export function pickVersion(doc, range) {
  const tags = doc['dist-tags'] || {};
  const versions = Object.keys(doc.versions || {});
  if (range && !validRange(range)) return tags[range] && doc.versions[tags[range]] ? tags[range] : null;
  const latest = tags.latest;
  if (latest && doc.versions[latest] && (!range || range === '*' || satisfies(latest, range))) return latest;
  return maxSatisfying(versions, range || '*');
}

export async function walkNpmTree(specs, fetchDoc, { signal, limits = NPM_LIMITS } = {}) {
  if (!Array.isArray(specs) || !specs.length || specs.length > limits.specs) throw failure('knpm needs 1 to 32 package specs', 'blocked');
  const docs = new Map();        // name -> Promise<doc|null>
  const ranges = new Map();      // name -> Set of ranges seen anywhere in the tree
  const picked = new Map();      // name -> Set of versions expanded
  const missing = new Set();
  let active = 0;
  const waiting = [];
  const gate = async (work) => {
    if (active >= limits.concurrency) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try { return await work(); } finally { active--; waiting.shift()?.(); }
  };
  const doc = (name) => {
    if (!docs.has(name)) {
      if (docs.size >= limits.packages) throw failure(`dependency tree exceeds ${limits.packages} packages`, 'blocked');
      docs.set(name, gate(() => fetchDoc(name)).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      }));
    }
    return docs.get(name);
  };
  const visit = async (edge) => {
    if (signal?.aborted) throw failure('request cancelled', 'cancelled');
    const seen = ranges.get(edge.name) || new Set();
    ranges.set(edge.name, seen);
    if (seen.has(edge.range)) return;
    seen.add(edge.range);
    const d = await doc(edge.name);
    if (!d) { missing.add(edge.name); return; }
    const version = pickVersion(d, edge.range);
    if (!version) { missing.add(`${edge.name}@${edge.range}`); return; }
    const done = picked.get(edge.name) || new Set();
    picked.set(edge.name, done);
    if (done.has(version)) return;
    done.add(version);
    const manifest = d.versions[version];
    const bundled = new Set([].concat(manifest.bundleDependencies || manifest.bundledDependencies || []));
    const next = [];
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, value] of Object.entries(manifest[field] || {})) {
        if (bundled.has(name)) continue;
        const child = registryEdge(name, value);
        if (child) next.push(child);
      }
    }
    await Promise.all(next.map(visit));
  };
  const roots = specs.map((spec) => {
    const edge = parseSpec(spec);
    if (!edge) throw failure(`not a registry package: ${String(spec).slice(0, 80)}`, 'blocked');
    return edge;
  });
  await Promise.all(roots.map(visit));

  const packuments = {};
  for (const [name, promise] of docs) {
    const d = await promise;
    if (!d) continue;
    const tags = d['dist-tags'] || {};
    const keep = new Set(picked.get(name) || []);
    if (tags.latest && d.versions[tags.latest]) keep.add(tags.latest);
    const accepted = [...(ranges.get(name) || [])].filter((range) => !range || validRange(range));
    for (const version of Object.keys(d.versions || {})) {
      if (accepted.some((range) => !range || satisfies(version, range))) keep.add(version);
    }
    const versions = {};
    for (const version of keep) versions[version] = d.versions[version];
    packuments[name] = { name: d.name || name, 'dist-tags': tags, modified: d.modified, versions };
  }
  return { packuments, missing: [...missing].sort(), packages: Object.keys(packuments).length };
}

async function readJSON(response, limit, signal) {
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    if (signal?.aborted) throw failure('request cancelled', 'cancelled');
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel?.().catch?.(() => {}); throw failure('registry document exceeds size limit', 'blocked'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// The bridge side: a request carrying `npm: { specs }` gets the bundle as its
// response body, streamed in bounded chunks like any download.
export function createNpmTree({ limits = NPM_LIMITS } = {}) {
  return {
    async open(request, controller, fetchRemote) {
      const npm = request.npm;
      if (!npm || typeof npm !== 'object' || !Array.isArray(npm.specs) || npm.specs.some((s) => typeof s !== 'string'))
        throw failure('invalid npm request', 'blocked');
      const signal = controller.signal;
      const started = Date.now();
      const fetchDoc = async (name) => {
        const href = `${NPM_REGISTRY}/${name.replace('/', '%2f')}`;
        const response = await fetchRemote(href, { method: 'GET', headers: { accept: CORGI }, signal });
        if (response.status === 404) return null;
        if (response.status !== 200) throw failure(`registry answered ${response.status} for ${name}`);
        return readJSON(response, limits.docBytes, signal);
      };
      const tree = await walkNpmTree(npm.specs, fetchDoc, { signal, limits });
      // With `plan`, one lockfile per spec, so the guest can run `npm ci` and
      // skip npm's resolver; a spec that cannot be planned falls back to npm.
      const plans = {}, planErrors = {};
      if (npm.plan === true) {
        for (const spec of npm.specs) {
          try { plans[spec] = planInstall([spec], tree.packuments); } catch (error) { planErrors[spec] = error.message; }
        }
      }
      const body = encoder.encode(JSON.stringify({ format: 1, ms: Date.now() - started, ...tree, plans, planErrors }));
      if (body.byteLength > limits.bundleBytes) throw failure('npm tree bundle exceeds size limit', 'blocked');
      let offset = 0;
      const stream = new ReadableStream({
        pull(sink) {
          if (offset >= body.byteLength) { sink.close(); return; }
          sink.enqueue(body.subarray(offset, offset + limits.chunkBytes));
          offset += limits.chunkBytes;
        },
      });
      return { type: 'basic', status: 200, url: NPM_REGISTRY + '/', redirected: false,
        headers: new Headers({ 'content-type': 'application/json' }), body: stream };
    },
  };
}

// The install layout, computed here so the guest's npm can skip its own
// resolver (`npm ci` instead of `npm install`): each package goes as high in
// node_modules as it can without a conflict, then a check pass nests a copy
// wherever Node's lookup would find a version the range does not accept.
// Returns a lockfileVersion 3 document for a root that depends on `specs`.
export function planInstall(specs, packuments, { name = 'knpm-install' } = {}) {
  const root = { name: '', parent: null, children: new Map(), edges: [] };
  const edgesOf = (manifest) => {
    const edges = [];
    const meta = manifest.peerDependenciesMeta || {};
    const bundled = new Set([].concat(manifest.bundleDependencies || manifest.bundledDependencies || []));
    for (const [field, optional] of [['dependencies', false], ['optionalDependencies', true], ['peerDependencies', false]]) {
      for (const [dep, value] of Object.entries(manifest[field] || {})) {
        if (bundled.has(dep) || (field === 'peerDependencies' && meta[dep]?.optional)) continue;
        if (field === 'dependencies' && manifest.optionalDependencies?.[dep]) continue;
        const edge = registryEdge(dep, value);
        if (edge) edges.push({ as: dep, ...edge, optional });
      }
    }
    return edges;
  };
  root.edges = specs.map((spec) => ({ as: parseSpec(spec).name, ...parseSpec(spec), optional: false }));
  const lookup = (node, as) => { for (let n = node; n; n = n.parent) if (n.children.has(as)) return n.children.get(as); return null; };
  // As npm's arborist: '' and '*' accept any version, prereleases included.
  const accepts = (child, edge) => child.name === edge.name && (!edge.range || edge.range === '*' ||
    (validRange(edge.range) ? satisfies(child.version, edge.range, { loose: true }) : child.version === packuments[edge.name]?.['dist-tags']?.[edge.range]));
  const queue = [root];
  const place = (node, edge, nested) => {
    const doc = packuments[edge.name];
    const version = doc && pickVersion(doc, edge.range);
    if (!version) {
      if (edge.optional) return null;
      throw failure(`no version of ${edge.name} matches ${edge.range || '*'}`, 'blocked');
    }
    let target = node;
    if (!nested) for (let n = node; n && !n.children.has(edge.as); n = n.parent) target = n;
    const manifest = doc.versions[version];
    const child = { as: edge.as, name: edge.name, version, manifest, parent: target, children: new Map(), edges: edgesOf(manifest) };
    target.children.set(edge.as, child);
    queue.push(child);
    return child;
  };
  // Shallow packages first, as npm does, so the common versions take the top.
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const edge of node.edges) {
      const found = lookup(node, edge.as);
      if (found && accepts(found, edge)) continue;
      if (found && node.children.get(edge.as) === found) {
        if (edge.optional) continue;
        throw failure(`conflicting versions of ${edge.as} under one package`, 'blocked');
      }
      place(node, edge, false);
    }
  }
  // Placing a package high can shadow what a deeper package found before it.
  for (let pass = 0, changed = true; changed; pass++) {
    if (pass > 50) throw failure('install layout did not settle', 'blocked');
    changed = false;
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      for (const edge of node.edges) {
        const found = lookup(node, edge.as);
        if (found && accepts(found, edge)) continue;
        if (!found && edge.optional && !packuments[edge.name]) continue;
        if (node.children.has(edge.as)) throw failure(`conflicting versions of ${edge.as} under ${node.name || 'the root'}@${node.version}: wants ${edge.range}, has ${node.children.get(edge.as).version}`, 'blocked');
        if (place(node, edge, true)) changed = true;
      }
    }
  }
  // Packages reachable only through optional edges are optional, so npm may
  // skip them on a platform they do not support.
  const required = new Set();
  const mark = (node) => {
    for (const edge of node.edges) {
      if (edge.optional) continue;
      const found = lookup(node, edge.as);
      if (found && !required.has(found)) { required.add(found); mark(found); }
    }
  };
  mark(root);
  const location = (node) => (node.parent === root ? '' : location(node.parent) + '/') + 'node_modules/' + node.as;
  const packages = { '': { name, dependencies: Object.fromEntries(root.edges.map((e) => [e.as, e.range || '*'])) } };
  for (const node of queue.slice(1).sort((a, b) => location(a).localeCompare(location(b)))) {
    const m = node.manifest;
    const entry = { version: node.version, resolved: m.dist?.tarball, integrity: m.dist?.integrity };
    if (node.as !== node.name) entry.name = node.name;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc', 'license', 'deprecated'])
      if (m[field] && (typeof m[field] !== 'object' || Object.keys(m[field]).length)) entry[field] = m[field];
    if (m.bin) entry.bin = typeof m.bin === 'string' ? { [node.name.split('/').pop()]: m.bin } : m.bin;
    if (m.hasInstallScript) entry.hasInstallScript = true;
    if (!required.has(node)) entry.optional = true;
    packages[location(node)] = entry;
  }
  return { name, lockfileVersion: 3, requires: true, packages };
}
