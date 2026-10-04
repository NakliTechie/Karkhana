// Browser check of the AI transport (Batch A): boots the real page in headless
// Chrome, points the agent tier at an OpenAI-compatible endpoint (Ferrule in
// mind), and proves that
//   - the guest finds the bridge through the standard OPENAI_*/ANTHROPIC_* env,
//     holding only a placeholder key,
//   - an SDK-shaped call with that placeholder gets the endpoint's answer, and
//   - the agent key is kept in IndexedDB only, not localStorage.
// Run, e.g. against `go run ./cmd/ferrule-demo -port 8899` in the Ferrule repo:
//   KARKHANA_AI_ENDPOINT=http://127.0.0.1:8899 KARKHANA_AI_KEY=frl_… KARKHANA_AI_MODEL=llama-3.1-8b-instruct \
//     node qemu-build/test-ai-bridge-browser.mjs
// KARKHANA_ROOT works as in test-persistent-disk.mjs.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, sleep, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const { KARKHANA_AI_ENDPOINT: ENDPOINT, KARKHANA_AI_KEY: KEY, KARKHANA_AI_MODEL: MODEL } = process.env;
const BOOT_MS = 240_000;

// What an OpenAI SDK does with the environment it is given. One line: the shell
// helper appends "; echo <marker>" to the command.
const SDK_CALL = "python3 -c \"import json,os,urllib.request as u; " +
  "r=u.Request(os.environ['OPENAI_BASE_URL']+'/chat/completions', data=json.dumps({'model':'default','messages':[{'role':'user','content':'Say hello.'}]}).encode(), " +
  "headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['OPENAI_API_KEY']}); " +
  "d=json.load(u.urlopen(r, timeout=120)); print('model='+str(d.get('model'))); print('content='+str(bool(d['choices'][0]['message']['content'])))\" 2>&1 | tail -3";

test('the AI bridge serves third-party agents with a placeholder key', { skip: !(ENDPOINT && KEY && MODEL) && 'set KARKHANA_AI_ENDPOINT, KARKHANA_AI_KEY and KARKHANA_AI_MODEL', timeout: BOOT_MS + 600_000 }, async (t) => {
  const server = await serve(ROOT);
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage();
  await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${PAGE}` });
  const { capture, run } = shell(page);
  await until('the page script', () => page.evaluate('!!window.karkhana?.shell'), 30_000);
  await capture();
  await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  await page.evaluate(`window.karkhana.ai.agent.config = ${JSON.stringify({ endpoint: ENDPOINT, model: MODEL, key: KEY })}; true`);
  await sleep(500); // the setter's IndexedDB write, which the service worker reads

  await t.test('the key is stored in IndexedDB, not localStorage', async () => {
    assert.equal(await page.evaluate("localStorage.getItem('karkhana-ai-agent')"), null);
    const stored = await page.evaluate(`new Promise((resolve) => { const o = indexedDB.open('karkhana', 1);
      o.onsuccess = () => { const r = o.result.transaction('kv').objectStore('kv').get('ai-agent'); r.onsuccess = () => resolve(r.result?.key === ${JSON.stringify(KEY)}); }; })`);
    assert.equal(stored, true);
  });

  await t.test('the guest environment names the bridge and holds a placeholder key', async () => {
    const env = await run('echo "$OPENAI_BASE_URL|$ANTHROPIC_BASE_URL|$OPENAI_API_KEY|$ANTHROPIC_API_KEY"', 60_000);
    assert.deepEqual(env, ['http://api.karkhana.internal/v1|http://api.karkhana.internal|karkhana-bridge|karkhana-bridge']);
  });

  await t.test('an SDK-shaped call with the placeholder gets the endpoint answer', async () => {
    const out = await run(SDK_CALL, 300_000);
    assert.ok(out.includes('content=True'), out.join('\n'));
    assert.ok(out.some((line) => line.startsWith('model=')), out.join('\n'));
  });
});
