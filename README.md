# Karkhana / कारख़ाना

A real Linux VM in your browser tab. Shell, filesystem, coding agent — no server, no install, nothing leaves your device.

**[Launch Karkhana](https://naklitechie.github.io/Karkhana/)** | **[Documentation](https://naklitechie.github.io/Karkhana/)** (click ? in-app)

---

## What this is

Karkhana boots a real Linux 6.8 kernel (i686) in your browser using [v86](https://github.com/copy/v86) x86 emulation. You get a full shell, a persistent filesystem backed by a folder on your machine, an LLM-powered coding agent, and an MCP server — all in a single browser tab with zero backend.

The name means "workshop" in Hindi/Urdu.

## What it does

| Feature | How it works |
|---|---|
| **Real Linux shell** | v86 emulates an x86 CPU, boots a Buildroot 6.8 kernel, serial console wired to xterm.js |
| **Persistent /workspace** | 9P filesystem bridges VM ↔ host via File System Access API. Pick a folder, files sync bidirectionally |
| **LLM bridge** | Agent inside VM writes HTTP requests to a file; browser polls, fires `fetch()` to LLM APIs, writes response back. Keys injected by bridge, never visible inside VM |
| **Multi-provider** | Anthropic, OpenRouter, OpenAI, LM Studio, Ollama — all via endpoint presets. Model discovery with CORS detection |
| **In-browser AI** | WebGPU models via Transformers.js (Qwen 0.5B–1.5B, SmolLM 1.7B). No API key needed |
| **MCP server** | Service Worker exposes `run_command`, `read_file`, `write_file` tools. External agents (Claude Code, Cursor) connect via config block |
| **JS API** | `window.karkhana` with `fs.read/write/list`, `shell.run`, `config.setProvider`, `snapshot/restore` |
| **Embed mode** | Load in iframe, postMessage bridge mirrors the full JS API |
| **File browser** | Sidebar tree view of /workspace with right-click context menus (preview, download, delete) |

## How it's different

### vs. Puter

[Puter](https://github.com/HeyPuter/puter) is a cloud desktop OS — it runs a full Node.js backend, manages user accounts, provides cloud storage, and presents a desktop metaphor with windows and apps. Karkhana is the opposite: **zero backend, single HTML file, everything local**. Where Puter gives you a cloud OS, Karkhana gives you a local Linux workshop. The key architectural difference is the agent model: Puter's AI features are backend API calls; Karkhana's agent runs *inside* the emulated Linux VM with real `fork()`, real filesystem, real shell — because that's what a coding agent actually needs.

### vs. copy.sh/v86

[v86](https://github.com/copy/v86) is the x86 emulator Karkhana is built on. The copy.sh demo lets you boot various OSes in the browser — it's a showcase. Karkhana wraps v86 into a product: persistent workspace, LLM bridge, agent harness, MCP server, and a UI designed for coding workflows rather than OS exploration.

### vs. StackBlitz/WebContainers

WebContainers run Node.js in the browser via WebAssembly. Karkhana runs *real Linux* — a full kernel with real syscalls, real processes, real `crontab`. The trade-off is speed (v86 emulation is ~30 MIPS vs native), but you get an environment where any Linux tool can run, not just Node.

## What we borrowed and extended

| Component | Source | What we extended |
|---|---|---|
| **[v86](https://github.com/copy/v86)** | x86 emulator + copy.sh demo build | Patched to expose emulator instance. Replaced demo UI with Karkhana shell (landing page, boot overlay, settings panel). Added 9P↔FSA filesystem bridge, networking bridge, MCP server — none of which exist in the v86 demo. |
| **[xterm.js](https://xtermjs.org)** | Terminal rendering | Themed to match Karkhana dark scheme. Scrollbar styled. Wired to v86 serial console (v86 demo uses its own xterm instance; we hide it and relay output). |
| **[Transformers.js](https://huggingface.co/docs/transformers.js)** v4 | In-browser ML inference | WebGPU worker pattern adapted from [VaultMind](https://github.com/NakliTechie/VaultMind) (another NakliTechie project). Added bridge routing so in-browser models serve agent requests without an API key. |
| **Buildroot bzImage** | Stock image from `i.copy.sh` | No modifications to the image itself. Agent harness, workspace symlink, and provider config injected at boot time via 9P + serial commands. |
| **v86 network relay** | `wss://relay.widgetry.org/` (by [nickvdp](https://github.com/nickvdp)) | Used for optional TCP/IP networking inside the VM (package installation, curl). Karkhana adds a toggle in settings. |

### What we studied but took a different direction from

- **[Puter](https://github.com/HeyPuter/puter)** — studied their window management, context menus, notification system, and AI SDK patterns. Adopted context menus and toast notifications for the file browser. Did not adopt: desktop metaphor, cloud backend, user accounts, app windowing system. The core difference is Puter is a cloud OS; Karkhana is a local Linux workshop.

## Architecture

```
Browser tab
  ├─ v86 emulator (x86 Linux 6.8 kernel)
  ├─ xterm.js (serial console ↔ VM shell)
  ├─ 9P filesystem (VM /workspace ↔ host files)
  │     └─ FSA (real folder) or OPFS (browser sandbox)
  ├─ Networking bridge (VM → browser fetch → LLM APIs)
  │     └─ Anthropic / OpenAI / Ollama / In-browser
  ├─ Agent harness (/usr/bin/agent)
  ├─ MCP Service Worker (external agents connect here)
  └─ window.karkhana JS API + postMessage embed bridge
```

## Quick start

1. Open [naklitechie.github.io/Karkhana](https://naklitechie.github.io/Karkhana/) (or serve locally: `python3 -m http.server 8766`)
2. Click **Launch Karkhana** — Linux boots in ~15 seconds
3. Type shell commands at the `~%` prompt
4. Click **Open Workspace** to connect a host folder
5. Open **Settings** to configure your LLM provider

## Local development

```bash
git clone https://github.com/NakliTechie/Karkhana.git
cd Karkhana
python3 -m http.server 8766
# Open http://localhost:8766
```

No build step. No npm install. No dependencies to install.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+B` | Toggle file browser sidebar |
| `Ctrl+,` | Toggle settings panel |
| `F1` | Open help |
| `Escape` | Close panels/menus |

## Project structure

```
Karkhana/
  index.html          # The entire app — markup, styles, logic
  v86.css              # v86 demo stylesheet
  mcp-sw.js            # MCP Service Worker
  build/
    v86_patched.js     # copy.sh v86 build (patched to expose emulator)
    v86.wasm           # Matching WASM (1.4 MB)
    xterm.js           # xterm.js for serial console
  bios/
    seabios.bin        # SeaBIOS firmware
    vgabios.bin        # VGA BIOS firmware
  images/
    buildroot-bzimage68.bin  # Buildroot Linux 6.8 (10 MB)
```

## Palette

Coloured with **`westafrica-10 · ÒRUN`** — the Yoruba night sky, kente-gold ink, electric-indigo directories. The "most vivid dark" in the Rangrez library, fitting for a hacker workshop where every directory is a constellation.

Palette pulled from [**Rangrez**](https://github.com/NakliTechie/rangrez), the global colour-palette library that backs all NakliTechie projects.

## Part of a series

Karkhana is part of the [NakliTechie](https://naklitechie.github.io/) collection of browser-native tools. No server, no API keys, no data leaving your device.

## License

[MIT](LICENSE)
