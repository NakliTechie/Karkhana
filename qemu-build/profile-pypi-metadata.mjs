// node qemu-build/profile-pypi-metadata.mjs [--fixture] [wheel-count]
// --fixture emits deterministic JSON for a browser/guest replay.
import { readFileSync } from 'node:fs';
import { syntheticProject } from './fixtures/pypi-project.mjs';
const document = syntheticProject(Number(process.argv.find(value => /^\d+$/.test(value)) ?? 10424));
if (process.argv.includes('--fixture')) {
  process.stdout.write(JSON.stringify(document));
} else {
  const source = readFileSync(new URL('./net/pypi-metadata.js', import.meta.url));
  const { encodeProject } = await import('data:text/javascript;base64,' + source.toString('base64'));
  const raw = JSON.stringify(document);
  const started = performance.now();
  const parsed = JSON.parse(raw);
  const parseMs = performance.now() - started;
  const transformed = encodeProject('metadata-fixture', parsed, 'http://127.0.0.1:12345', 'json');
  console.log(JSON.stringify({ environment: 'host Node; not a guest install measurement',
    wheels: transformed.additions.size, inputBytes: Buffer.byteLength(raw), outputBytes: transformed.bytes.byteLength,
    parseMs, transformAndEncodeMs: performance.now() - started - parseMs }));
}
