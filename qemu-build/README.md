# Karkhana qemu-wasm engine

Debian 12 (x86_64, glibc) booting in a browser tab on QEMU-compiled-to-wasm
(ktock/qemu-wasm via container2wasm). This is what karkhana.naklitechie.com
serves. It replaced the v86 32-bit engine, which is preserved on branch
`legacy/v86` and still served from naklitechie.github.io/Karkhana.

## Build & run

```
./run-build.sh             # build.sh with the Docker credential workaround (see below)
                           #   guest image (Dockerfile.guest) -> c2w -> out/htdocs (~600MB)
                           #   then stages a publishable tree into publish/
python3 serve.py 8793      # COOP/COEP static server over out/htdocs
# open http://127.0.0.1:8793/karkhana.html
```

**Always build through `run-build.sh`.** Docker Desktop's credential helper
(`credsStore: "desktop"` in `~/.docker/config.json`) hangs image resolution
indefinitely on this machine — no output, no error, 0% CPU, while DNS and the
registry auth endpoint answer normally. It cost twenty minutes of a build that
looked like it was running. The wrapper sets `DOCKER_CONFIG=$HOME/.docker-nocreds`,
a copy of the config with `credsStore` / `credHelpers` / `auths` stripped, so
pulls go out anonymously. Every image c2w needs is public. Recreate that copy
with:

```
cp -R ~/.docker ~/.docker-nocreds   # then delete credsStore/credHelpers/auths from config.json
```

Requires Docker, Go (for net/c2w-net), node/npm (for net/stack), and read access
to a container2wasm checkout (path in build.sh; currently beagle's vendored copy —
used strictly read-only).

## Publishing

The repo is the only artifact store. Cloudflare Pages serves the **repo root**
straight from `main`, and it refuses any file over 25 MB, so the engine ships as
20 MB parts plus a manifest that the page reassembles.

```
./build.sh                 # ends by staging publish/
./chunk.sh                 # or run the staging step alone
./publish.sh --dry-run     # replace the published tree, show the diff, stop
./publish.sh               # replace the published tree, commit, push
```

`publish.sh` writes to the repo root, so the paths a publish owns (`engine/`,
`dist/`, `vendor/`, the page and its glue) are named explicitly in an `OWNED`
list rather than cleared with a blanket `rm -rf` — the destination is the
working tree. The staged `karkhana.html` becomes `index.html` at the root.

`chunk.sh` splits anything over the cap, writes `engine/engine-manifest.json`
(parts in order plus byte size), and then **reassembles the parts in memory and
compares SHA-256 against the original**. A corrupt engine costs a 640 MB
force-push to undo, so the check is not optional.

`publish.sh` derives an engine id from the manifest and stamps it into the
cache name in `karkhana.html` and `karkhana-sw.js`. This is load-bearing: the
service worker is cache-first for `.wasm` / `.data` / `.gzip`, so without a new
cache name a returning browser keeps booting the previous engine with no error
to explain it. The script refuses to publish if the stamp did not apply.

### Force-push discipline

Engine updates **replace** history, they never accumulate — 640 MB of
superseded parts per release would make the clone unusable within a few
releases.

- If the branch tip is already an `Engine <id>` commit, `publish.sh` amends it
  and force-pushes with `--force-with-lease`. Anyone holding the old commit
  must re-clone or `reset --hard`.
- If the tip is anything else, it makes a **new** commit and pushes normally,
  because amending unrelated work would be unrecoverable for anyone who already
  pulled. The previous engine stays in history behind it; squash it out when
  the clone starts to hurt. The next publish on top will replace.

### One page, two modes

`karkhana.html` is a single source used by both the local build output and the
published tree (where it is renamed `index.html`). At boot it probes for
`engine/engine-manifest.json`: found means assemble from parts and hand
emscripten blob URLs, absent means let emscripten fetch the `.data` whole. Only
the cache-name stamp is rewritten at publish time, so the two modes cannot
drift apart.

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
  correctly.
- **9p virtfs CREATE returning EPERM — FIXED by our carried patch** (branch
  `fix/9p-path-chmod` on the fork). Emscripten defines `O_PATH` but openat()
  ignores it, so `fchmodat_nofollow()` took the Linux path that re-opens the
  file through `/proc/self/fd/<n>` — and emscripten has no `/proc`. The chmod
  failed, and `local_open2()`'s error path unlinked the file it had just
  created, so every create failed after succeeding. The fix treats `O_PATH` as
  unsupported on emscripten so the existing fallback `fchmod()`s the descriptor
  directly.
- **Bun binaries trap** (opencode etc.): need SSE4.2+; wasm TCG's qemu64 is
  SSE2-era; `-cpu max` kernel-panics, `Nehalem` hangs (seam kept in
  Dockerfile.builder). Prebuilt Go/baseline-Rust binaries run fine (uv proves it).
- **Guest RAM ceiling:** 2048M fails silently (wasm heap is 3000M at QEMU
  compile); stay at 1024M until the heap build-arg is raised.
- **Entropy: FIXED** — carried kernel patch adds CONFIG_HW_RANDOM_VIRTIO +
  `-device virtio-rng-pci`; crng init at ~2.4 guest-seconds (was 90-560 s).
  TLS entropy stalls (git/node first-use hangs) are gone.
