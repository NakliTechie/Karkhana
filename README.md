# Karkhana / कारख़ाना

A real Linux VM in your browser tab. Shell, package manager, coding agent — no server, no install, nothing leaves your device.

**[Launch Karkhana](https://karkhana.naklitechie.com/)**

The name means "workshop" in Hindi/Urdu.

## What this is

Karkhana boots **Debian 12 bookworm, x86_64, glibc 2.36** in a browser tab. Not a shim, not a Node sandbox — a full kernel (Linux 6.1) with real syscalls, real processes, and a real package manager, running on QEMU compiled to WebAssembly.

That means `apt`-era userland expectations hold: Python 3.11 and Node 18 are there, `uv pip install` and `npm install -g` fetch from the real registries, and a coding agent runs *inside* the VM with a real filesystem to work on.

The first visit downloads a ~640 MB engine and takes a minute or two, most of it transfer. The engine is then cached in the browser, and later visits start from that copy.

## What's inside the guest

| | |
|---|---|
| **Base** | Debian 12 bookworm, x86_64, glibc 2.36, Linux 6.1, 4 vCPUs (MTTCG), 1024 MB RAM |
| **Languages** | Python 3.11.2, Node 18.20.4, sqlite3, git, curl |
| **Python packages** | `kpip <pkg>` — `uv` tuned for the in-page network path. Plain `pip` stalls against the proxy; `uv` does not |
| **Node packages** | `npm install -g` works against the real registry |
| **Persistence** | `ksave` tars `/usr/local` + `/root` to `/persist/state.tar`; the page mirrors it to OPFS within a few seconds and restores it at the next login |
| **Agent** | `/usr/bin/agent "task"` — an OpenAI-protocol tool loop with `run_command` / `read_file` / `write_file` / `list_directory` |

## Networking

The guest gets a real NIC, not a shimmed `fetch`. Two modes, auto-selected at boot:

- **In-page fetch stack (zero-install, what the hosted site uses).** [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock) compiled to wasm, with egress through the browser's own `fetch()`. Bounded by CORS, so PyPI and npm work; `apt`, `git` and GitHub releases do not.
- **Relay (development).** Run `net/c2w-net -listen-ws localhost:8888` on your machine and the page picks it up, giving the guest real TCP/IP — plain `pip`, `git`, `apt`, anything.

## AI, and how the key stays out of the VM

Two tiers, both optional — pull them out and the Linux box is unchanged.

- **General-purpose:** on-device Gemini Nano where the browser offers it, with no key and no network call.
- **Agent:** bring your own endpoint and key in the ⚙ panel.

The key never enters the VM. The guest talks to `api.karkhana.internal`; that request surfaces in the service worker, which rewrites it to your configured endpoint and injects the `Authorization` header from IndexedDB. Nothing inside the guest can read it — an in-guest `env | grep -ci secret` returns 0 while the bridge is working.

## JS API

`window.karkhana` is the same seam the page's own UI uses:

```js
karkhana.shell.exec('uname -a')        // run a command
karkhana.shell.send('partial input')   // write without a newline
karkhana.shell.onData(cb)              // subscribe to guest output
karkhana.persist.pull()                // mirror saved state to OPFS now
karkhana.persist.forget()              // drop saved state
karkhana.net                           // { mode, cert } — which network path is live
karkhana.ai.gp.ask(prompt)             // on-device tier
```

Read output through `onData`. The terminal renders to canvas, so the DOM has nothing to scrape.

## Not here yet

The 32-bit build had several things this one does not. Named plainly rather than left to discovery:

- **No host-folder workspace.** The v86 build bridged a real folder in via the File System Access API. The qemu-wasm guest has `/persist` (OPFS-backed) and no host folder.
- **No MCP server**, so external agents cannot connect to the VM yet.
- **No file browser, toasts, or help modal.** The v86 sidebar read the guest filesystem directly; here the filesystem is only reachable through `shell.exec`, so the tree needs building rather than porting.
- **No `fs` JS API** — `shell.exec` is the way in.
- **Bun-based tools** (opencode and friends) trap: they need SSE4.2, and wasm TCG's `qemu64` is SSE2-era. Prebuilt Go and baseline-Rust binaries run fine.

## How it's different

**vs. [WebContainers](https://webcontainers.io)** — WebContainers run Node in the browser. Karkhana runs Linux: real syscalls, real processes, real `crontab`, any language. The trade is speed — emulation, not native.

**vs. [Puter](https://github.com/HeyPuter/puter)** — Puter is a cloud desktop with a Node backend, accounts and cloud storage. Karkhana has no backend at all. The sharpest difference is the agent: Puter's AI is a backend API call, Karkhana's agent runs inside the VM with a filesystem to act on.

**vs. [copy.sh/v86](https://copy.sh/v86/)** — where Karkhana started, and still a fine 32-bit emulator. The move to qemu-wasm was about the userland ceiling: i686 musl Alpine could not run a modern Python or Node toolchain. Debian x86_64 can.

## Built on

| Component | What it does |
|---|---|
| [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) | QEMU compiled to WebAssembly — the emulator itself |
| [container2wasm](https://github.com/ktock/container2wasm) | Turns a container image into a bootable browser bundle |
| [xterm.js](https://xtermjs.org) + xterm-pty | Terminal, wired to the guest's serial console |
| [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock) | The user-mode network stack behind the in-page proxy |

Karkhana runs a **fork of qemu-wasm** carrying three fixes, because upstream has been dormant since September 2025:

- **9p errno mistranslation** — WASI error numbers were passed to the guest as if they were Linux ones, so a missing file reported "Channel number out of range". Filed as [ktock/qemu-wasm#45](https://github.com/ktock/qemu-wasm/issues/45), fixed in [#46](https://github.com/ktock/qemu-wasm/pull/46).
- **9p file creation failing with EPERM.** Emscripten defines `O_PATH` but `openat()` ignores it, so the chmod path re-opened the file through `/proc/self/fd/<n>` — and emscripten has no `/proc`. The failure then unlinked the file it had just created, so every create failed *after* succeeding.
- **Entropy starvation** — a carried kernel config plus `virtio-rng-pci` brings `crng init` down from 90–560 seconds to about 2.4, which is what made TLS usable in the guest.

## Quick start

1. Open **[karkhana.naklitechie.com](https://karkhana.naklitechie.com/)** and wait for the engine to download.
2. Type at the `karkhana:~$` prompt.
3. `kpip <pkg>` for Python, `npm install -g <pkg>` for Node.
4. `ksave` to keep what you installed; it comes back on the next visit.
5. ⚙ to point the agent at an endpoint, then `agent "what does this script do?"`.

## Local development

The page and its glue are static — no build step, no npm install:

```bash
git clone https://github.com/NakliTechie/Karkhana.git
cd Karkhana/qemu-build && python3 serve.py 8793
```

That serves a local engine build out of `qemu-build/out/htdocs`. To serve the published tree instead, any COOP/COEP-setting static server over the repo root works; plain `python3 -m http.server` does not, because SharedArrayBuffer needs cross-origin isolation.

Rebuilding the engine itself (Docker, Go, node) is documented in **[`qemu-build/README.md`](qemu-build/README.md)**, along with the publish pipeline and its force-push discipline.

**If a local page stalls before the engine downloads:** the service worker is cache-first on `.wasm` / `.data`, and only a publish stamps a new cache name, so a local rebuild does not invalidate it. Clear it with:

```js
navigator.serviceWorker.controller.postMessage('karkhana-clear-cache')
```

## Project structure

```
Karkhana/
  index.html              # the app — boot overlay, terminal, settings, agent seam
  karkhana-sw.js          # engine cache, COI headers, BYOK bridge
  load.js  out.js  arg-module.js    # emscripten glue from the qemu-wasm build
  c2w-net-proxy.wasm.gzip # in-page network proxy
  dist/                   # network stack worker
  vendor/                 # xterm.js, xterm-pty
  engine/                 # the engine: 30 .data parts + 2 .wasm parts + manifest
  qemu-build/             # how the engine is built, chunked and published
```

The engine ships as 20 MB parts because Cloudflare Pages refuses files over 25 MB; the page reassembles them in memory at boot. The repo is the only artifact store — there is no bucket to lose.

## The v86 archive

The original 32-bit build (v86, Alpine 3.18, i686, musl) is preserved on branch **`legacy/v86`**, tag **`v86-final`**, and still runs at **[naklitechie.github.io/Karkhana](https://naklitechie.github.io/Karkhana/)**. It has the host-folder workspace, the MCP server, the file browser and the `fs` JS API — the features listed above as missing here. If you want those today, that is where they live.

## Palette

Coloured with **`westafrica-10 · ÒRUN`** — Yoruba night sky, kente-gold ink, electric-indigo directories. The most vivid dark in the [Rangrez](https://github.com/NakliTechie/rangrez) library, which backs all NakliTechie projects.

## Part of a series

Karkhana is part of the [NakliTechie](https://naklitechie.github.io/) collection of browser-native tools. No server, no accounts, no data leaving your device.

## License

[MIT](LICENSE)
