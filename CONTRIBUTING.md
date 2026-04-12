# Contributing to Karkhana

Thanks for your interest. Karkhana is a single-file browser app — contributions should keep it that way.

## Ground rules

1. **Single HTML file.** All markup, styles, and logic live in `index.html`. No build step, no bundler, no framework.
2. **No server dependencies.** Everything runs in the browser. No Node.js backend, no database, no accounts.
3. **No data leaves the device.** API keys stay in localStorage. Files stay on the user's machine. No telemetry.
4. **Test in Chrome.** Karkhana uses WebGPU, File System Access API, and Service Workers — Chrome has the best support.

## What to work on

Check [ROADMAP.md](ROADMAP.md) for priorities. Good first contributions:

- **Custom disk image** — build an Alpine-based v86 image with Python 3 pre-installed
- **Agent harness** — shell script agent that works with the stock Buildroot image (no Python needed)
- **Terminal improvements** — split panes, tabs, command history search
- **File browser** — drag-drop upload, rename, new file/folder
- **Theming** — user-configurable terminal colors

## How to contribute

1. Fork the repo
2. Create a branch (`git checkout -b feature/your-feature`)
3. Make your changes in `index.html` (or supporting files like `mcp-sw.js`)
4. Test locally: `python3 -m http.server 8766`
5. Open a pull request with a clear description of what and why

## Code style

- Vanilla JS, no frameworks
- `var` for function-scoped variables in the v86 integration layer (compatibility with the minified v86 build)
- Modern JS (const/let, async/await, arrow functions) is fine in new code
- CSS inline in `<style>` tags
- Colors: `#0c0c14` (background), `#1a1a24` (borders), `#ff6b35` (accent)

## Architecture notes

- **v86 build:** We use the copy.sh `v86_all.js` build, not the npm package or GitHub releases (those have a bzImage boot bug). The emulator instance is exposed via `window.__karkhana_emulator` through a 1-line patch.
- **Minified API:** The copy.sh build minifies property names. `emulator.Aj(path, data)` = create_file, `emulator.Yf(path)` = read_file, `emulator.v` = bus. These are fragile — if the v86 build is updated, they may change.
- **9P mount:** Files written via `emulator.Aj()` appear at `/mnt/` inside the VM. `/workspace` is a symlink to `/mnt/`, created at boot via serial command.

## Questions?

Open an issue or reach out at [naklitechie.github.io](https://naklitechie.github.io/).
