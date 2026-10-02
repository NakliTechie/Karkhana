// Browser check of the guest terminal size: boots the real page and engine in
// headless Chrome at a 1440x810 viewport and drives it over the DevTools
// protocol (Node 22's built-in WebSocket; no packages). Proves that
//   - the guest pty reports the page terminal's size at the first prompt,
//   - a 120-character command echoes on one rendered row,
//   - a viewport resize reaches the guest pty, and
//   - a foreground program receives SIGWINCH with the new size.
// Run: node qemu-build/test-terminal-size.mjs
// KARKHANA_ROOT serves another tree (default: the repository root).
// CHROME names the browser binary (default: the macOS Google Chrome install).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve, shell, until } from './browser-harness.mjs';

const ROOT = path.resolve(process.env.KARKHANA_ROOT || fileURLToPath(new URL('..', import.meta.url)));
// A staged tree from chunk.sh serves karkhana.html; publish.sh renames it index.html.
const PAGE = existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : 'karkhana.html';
const BOOT_MS = 180_000;

// Rendered terminal rows, trailing blanks trimmed. xterm.js draws rows as DOM text here.
const ROWS = `[...document.querySelectorAll('#terminal .xterm-rows > div')]
  .map((row) => row.textContent.replace(/\\s+$/, ''))`;

test('the guest terminal follows the page terminal size', { timeout: BOOT_MS + 120_000 }, async (t) => {
  const server = await serve(ROOT);
  const browser = await launch();
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); server.close(); });
  await page.viewport(1440, 810);
  await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${PAGE}` });
  await until('the guest shell', () => page.evaluate('window.karkhana?.vm.state === "shell"'), BOOT_MS);
  const { capture, output, run } = shell(page);
  await capture();
  const guestSize = async () => (await run('stty size'))[0];
  const pageSize = () => page.evaluate('window.karkhana.shell.size');

  await t.test('the first prompt carries the page size', async () => {
    const { cols, rows } = await pageSize();
    assert.ok(cols > 150, `a 1440px viewport must give well over 150 columns, got ${cols}`);
    assert.equal(await guestSize(), `${rows} ${cols}`);
  });

  await t.test('a 120-character command echoes on one row', async () => {
    const text = 'Write a warm two-sentence thank-you note to my team. Save it to a file, then show me the note.';
    const command = `echo "${text.padEnd(113, '.')}"`;
    assert.equal(command.length, 120);
    const { cols } = await pageSize();
    await run(command);
    const rows = await page.evaluate(ROWS);
    const echoed = rows.findIndex((row) => row.startsWith('karkhana:') && row.includes(command));
    assert.notEqual(echoed, -1, `no rendered row holds the whole command:\n${rows.join('\n')}`);
    assert.ok(rows[echoed].length <= cols, 'the echoed row must fit the terminal width');
    assert.equal(rows[echoed + 1], text.padEnd(113, '.'), 'the output must start on the next row');
  });

  await t.test('a viewport resize reaches the guest pty', async () => {
    const before = await pageSize();
    await page.viewport(1000, 700);
    const after = await until('xterm to refit', async () => {
      const size = await pageSize();
      return size.cols !== before.cols ? size : null;
    });
    await until(`guest size ${after.rows} ${after.cols}`, async () => (await guestSize()) === `${after.rows} ${after.cols}`);
  });

  await t.test('a foreground program receives SIGWINCH with the new size', async () => {
    const before = await pageSize();
    await page.evaluate('window.__out = ""; true');
    await page.evaluate(`window.karkhana.shell.exec(${JSON.stringify(
      `bash -c 'trap "echo WINCH-\\$(stty size); exit" WINCH; echo WAITING; while :; do sleep 0.2; done'`)})`);
    await until('the trap to install', async () => /WAITING\r*\n/.test(await output()));
    await page.viewport(1440, 810);
    const after = await until('xterm to refit', async () => {
      const size = await pageSize();
      return size.cols !== before.cols ? size : null;
    });
    await until(`WINCH-${after.rows} ${after.cols}`, async () => (await output()).includes(`WINCH-${after.rows} ${after.cols}`));
  });
});
