# Karkhana qemu-wasm engine

Debian 12 (x86_64, glibc) booting in a browser tab on QEMU-compiled-to-wasm
(ktock/qemu-wasm via container2wasm). Replaces the v86 32-bit engine
(preserved on branch `legacy/v86`).

## Build & run

```
./build.sh                 # guest image (Dockerfile.guest) -> c2w -> out/htdocs (~600MB)
python3 serve.py 8793      # COOP/COEP static server
# open http://127.0.0.1:8793/karkhana.html
```

Requires Docker, Go (for net/c2w-net), node/npm (for net/stack), and read access
to a container2wasm checkout (path in build.sh; currently beagle's vendored copy —
used strictly read-only).

## What's inside the guest

Python 3.11 + uv (`kpip <pkg>` = tuned installer), Node 18, sqlite3, git, curl,
`/usr/bin/agent` (OpenAI tool-loop agent; BYOK key never enters the VM),
`ksave`/`krestore` (persistence), TERM=xterm-256color, 4 vCPUs (MTTCG), 1024M RAM.

## Networking — two modes, auto-selected

1. **Relay (recommended, dev mode):** run `net/c2w-net -listen-ws localhost:8888`
   on the host. The page probes it at load; guest gets REAL TCP/IP — plain pip,
   git, apt, any tool. **Ops:** restart the relay after any guest network hang —
   a stale relay blocks the next boot. First network command after boot can stall
   ~1-2 min on kernel entropy (crng); a login hook warms it; retry once if a
   command times out (use `timeout 90 <cmd>` for safety).
2. **In-page fetch stack (zero-install):** gvisor-tap-vsock compiled to wasm,
   egress via browser fetch(). CORS-bounded: PyPI/npm work (`kpip`, npm with
   `NODE_EXTRA_CA_CERTS=/.wasmenv/proxy.crt`); apt/git/GitHub-releases don't.

## Persistence

`ksave` in the guest tars /usr/local + /root into /persist/state.tar; the page
auto-mirrors it to OPFS within 4 s; next boot auto-restores at first login.
`karkhana.persist.forget()` in the console clears the saved state.

## AI (naklios two-tier)

⚙ panel: GP tier → on-device Gemini Nano when available (`builtin:nano`);
agent tier → BYOK endpoint (key stays in the browser; SW injects it at
`api.karkhana.internal`). In-guest `agent "task"` speaks OpenAI protocol.

## Known issues

- **9p WASI-errno mistranslation — FIXED by our carried patch** (upstream:
  issue ktock/qemu-wasm#45, PR ktock/qemu-wasm#46; builder compiles from
  NakliTechie/qemu-wasm `build/9p-fix-8604`). Lookup-miss now returns ENOENT
  correctly. Follow-up bug surfaced by honest errnos: guest-side file CREATE on
  virtfs still fails with a genuine EPERM (local-backend create path; both
  security models) — to be filed upstream. ksave/tar persistence unaffected.
- **Bun binaries trap** (opencode etc.): need SSE4.2+; wasm TCG's qemu64 is
  SSE2-era; `-cpu max` kernel-panics, `Nehalem` hangs (seam kept in
  Dockerfile.builder). Prebuilt Go/baseline-Rust binaries run fine (uv proves it).
- **Guest RAM ceiling:** 2048M fails silently (wasm heap is 3000M at QEMU
  compile); stay at 1024M until the heap build-arg is raised.
- **Entropy: FIXED** — carried kernel patch adds CONFIG_HW_RANDOM_VIRTIO +
  `-device virtio-rng-pci`; crng init at ~2.4 guest-seconds (was 90-560 s).
  TLS entropy stalls (git/node first-use hangs) are gone.
