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

Python 3.11 + uv (`kpip <pkg>` = tuned installer), Node 22, sqlite3, git, curl,
`/usr/bin/agent` (OpenAI tool-loop agent; BYOK key never enters the VM),
`ksave`/`krestore` (persistence), TERM=xterm-256color, 4 vCPUs (MTTCG), 1792M RAM.

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

### Direct PyPI downloads

`kpip-fast PACKAGE` offers an opt-in package path over the existing `/persist`
9p mount. It starts a temporary guest loopback index, then runs uv against it.
The browser performs HTTPS requests for index metadata and wheel bytes.
No external guest TCP or guest TLS participates in those downloads.

The page stages `kfetch.py` and `kpip_fast.py` into `/persist/.karkhana-net`
before boot. `/pack/info` adds their wrappers to the guest's PATH. Existing
engine snapshots therefore need no rebuild. `build.sh`, `chunk.sh`, and
`publish.sh` carry the bridge, metadata processor, and Python assets on subsequent rebuilds.

`net/browser-fetch.js` implements four preallocated mailbox slots. Protocol 2
places slots beneath a fresh generation directory. Retired clients cannot read
or acknowledge successor files, even when reset occurs between marker and payload reads.
Stop retires that directory after active work drains. Restart rejects while
drainage is pending; callers may retry after the active counter reaches zero.
Only one bridge may own an FS/root pair. Repeated start remains idempotent.
The guest rejects mismatched protocols with a reload message. Each slot
holds one request and one response chunk, capped at 256 KiB. A generation,
request ID, and sequence number bind every publication and acknowledgement.
Small browser fragments combine into full chunks before publication. Only
the final chunk may be shorter, avoiding an acknowledgement per network fragment.
The browser waits for an acknowledgement before advancing the stream.
Cancellation and total timeouts abort browser requests. Truncated transfers
produce errors, never a successful EOF. `kfetch -o FILE` replaces its output
only after a complete response.

Each guest response reuses unbuffered `ready`, `chunk`, and `ack` descriptors.
Reads seek to offset zero for each publication. Partial reads and writes complete
within the existing bounds. EOF, cancellation, and failures close every descriptor
before releasing the slot lock. Closing a suspended iterator prevents further
acknowledgements. Handles never carry into another response or bridge generation.
One iterator owns each Response. Total deadlines also apply when a consumer
resumes after a delay. Aborted browser reads release their slot even when the
upstream read promise does not settle. Malformed configuration and frame shapes
produce bounded bridge errors.
Run `python3 qemu-build/test-kfetch.py` for local lifecycle and concurrency checks.
The [2026-09-29 hardening evidence](hardening-transport-2026-09-29.json) records
101 host checks, independent probes, 24 deliberate negative controls, and one full installation.

The browser permits only `GET` and `HEAD` on exact HTTPS PyPI/pythonhosted
origins. It omits cookies, referrers, and credentials. It rejects redirects,
URL credentials, and unsupported headers. The BYOK hostname cannot enter this
path. Fetch decodes HTTP content encoding; the adapter drops those wire
headers and supplies its own chunked response framing.

The browser rewrites PyPI file URLs while preserving hashes, Python version
requirements, yanked markers, and advertised wheel metadata. It offers only
wheels. Installer config and proxy overrides cannot select another index.
An explicit loopback proxy rejects external HTTP targets and HTTPS CONNECT.
The existing `kpip`, npm, relay, and gvisor paths remain available.

`net/pypi-metadata.js` fetches and parses project JSON in the browser. It
validates wheel URLs before URL normalization can remove traversal segments.
It encodes JSON or HTML once. The guest forwards these encoded bytes without
parsing, rewriting, serializing, or retaining the project document.

Each install creates a random session bound to its exact loopback origin.
Wheel downloads require an exact advertised route within that session.
Sidecars require the advertised metadata permission. Cached responses retain
hashes, Python requirements, yanked values, and both metadata attributes.
Concurrent requests for one session, project, and format share processing.
Cancelling one caller leaves the other callers running. Cancelling every
caller aborts the shared upstream request.

A browser-wide LRU cache holds at most 16 MiB across 128 encoded responses.
Input documents are capped at 16 MiB; encoded responses are capped at 32 MiB.
The browser permits eight sessions, 200,000 wheel records per session,
400,000 records overall, and a 128 MiB estimated registry storage budget.
Oversized requests fail before adding wheel permissions.

The adapter explicitly closes its session after uv exits, including failure.
Close aborts active work and releases its cache and wheel permissions.
Abandoned sessions expire after ten idle minutes; the bridge sweeps every
30 seconds. Active requests prevent idle expiry. Bridge stop clears all
sessions. Late completions cannot recreate closed session state.

The adapter sets uv's HTTP timeout to 180 seconds. Browser requests retain
separate 120-second total timeouts, including mailbox backpressure.

Limits: source builds, private indexes, requirement files, direct URL/VCS
dependencies, npm, and arbitrary origins are unsupported. CORS still applies.
The guest still spends CPU on Python, loopback HTTP, 9p, decompression, and
installation.

On September 29, paired downloads used fresh query strings for the same
18,252,005-byte NumPy wheel. Direct transfers took 15.98 and 16.14 guest
seconds; legacy curl took 15.61 and 15.51. All four downloads matched SHA-256
`666dbfb6ec68962c033a450943ded891bed2d54e6755e35e5835d63f4f6931d5`.
These raw-download samples demonstrate no speedup.

On September 29, fresh full `aider-chat==0.86.2` installations used the same
engine and identical package versions. The command suffix was
`--no-cache --reinstall aider-chat==0.86.2`.

| Path | Host install seconds | Guest resolver seconds |
|---|---:|---:|
| Previous `kpip-fast` | 819.997 | 477 |
| Browser metadata `kpip-fast` | 341.005 | 124 |
| Legacy `kpip` | 436.010 | 144 |

All three passed dependency and terminal checks. The optimized run closed
all metadata sessions and released its registry and cache.
This single comparison shows 74.0% shorter guest resolution than the previous
adapter and 21.8% shorter host installation than legacy `kpip`.
The previous adapter recovered one failed download, which also affects its
total duration. Host intervals and guest phases use different clocks.
These samples do not establish a general speed distribution.
The [measurement record](benchmark-metadata-2026-09-29.json) includes engine
hashes, asset hashes, package versions, phase timings, and limitations.

A subsequent handle-reuse comparison kept the engine unchanged. Two paired
18,252,005-byte fixture copies took 8.099/9.006 host seconds before reuse and
3.005/3.681 after reuse. Remote `kfetch` CLI samples took 16.342/16.531 seconds
before reuse and 11.952/12.279 afterward. All 22 guest payload checks matched
the pinned wheel's byte count and SHA-256. Two browser downloads also matched.

One fresh `aider-chat==0.86.2` install per implementation took 328.009 host
seconds before reuse and 311.006 afterward, a 5.18% reduction. Both inventories
contained the same 112 distributions. The command installed 108 packages;
uv checked 109 packages. Guest resolution took 121 versus 103 seconds,
preparation took 140 versus 139, and installation took 12.83 versus 12.66.
These samples do not establish a general speed distribution. This comparison
includes no legacy-path timing. The [transport measurement record](benchmark-transport-2026-09-29.json)
preserves sample timings, source hashes, fixture identity, validation counts,
and limitations.

Host checks require Node and Python, without an engine rebuild:

```bash
node qemu-build/test-browser-fetch.mjs
node qemu-build/test-pypi-metadata.mjs
python3 qemu-build/test-kpip-fast.py
python3 qemu-build/test-kpip-cache.py
python3 qemu-build/test-kfetch.py
node qemu-build/test-pty.mjs
node qemu-build/test-agent-bridge.mjs
python3 qemu-build/test-karkhana-tty.py
node qemu-build/test-opfs-disk.mjs
```

The first suite includes the actual Python adapter and client against the JS
bridge. A disposable browser run must additionally verify 9p visibility,
runtime PATH, real CORS responses, a package install, and post-install liveness.
Inspect `karkhana.net.directFetch` for transfer and metadata counters.
`test-agent-bridge.mjs` runs the service worker's fetch handler against a fake IndexedDB
and a mock fetch: the model from the ⚙ panel must replace the guest agent's
placeholder `default` on chat-completions requests, and the published
`karkhana-sw.js` must match `qemu-build/karkhana-sw.js` except for the cache stamp.
`test-opfs-disk.mjs` runs the real disk worker in a Node worker thread against
a file-backed stand-in for OPFS with one handle per file. It covers seeding,
bounce-buffer boundaries, growth, the busy fallback, the reload retry, quota
errors, and the Emscripten FS ops.

`node qemu-build/test-persistent-disk.mjs` boots a tree in headless Chrome. It
checks the mounted 16 GiB disk, survival of a reload and of an unsynced tab
close, tmpfs `/tmp`, the second-tab scratch fallback, and first-visit OPFS cost.
Set `KARKHANA_ROOT=qemu-build/publish` to test a staged build before publishing.

### Terminal size

QEMU's serial console carries no window size. The guest pty therefore started
at 0x0, and bash wrapped command lines at 80 columns, back over their own row.
The page now stages `rows R cols C` and `guest/karkhana-tty.sh` into
`/persist/.karkhana-tty` before boot. It rewrites the size on every xterm resize.
`/pack/info` sets `PROMPT_COMMAND` to source the script at the first prompt,
so the size applies before that prompt prints. A watcher in its own process
group then re-applies the size within a second of a resize. The kernel sends
SIGWINCH to the foreground job, so readline and full-screen programs redraw.
The snapshot needs no rebuild.

`python3 qemu-build/test-karkhana-tty.py` drives interactive bash on a real pty.
Run it under the guest's bash 5.2 as well:

```bash
docker run --rm --init -v "$PWD:/w" karkhana-debian:amd64 python3 /w/qemu-build/test-karkhana-tty.py
```

`node qemu-build/test-terminal-size.mjs` boots the published tree in headless
Chrome at 1440x810. It checks the first-prompt size and a 120-character command
echoed on one row. It also checks resize propagation and SIGWINCH delivery.
`KARKHANA_ROOT` selects another tree; `CHROME` selects the browser binary.

`node qemu-build/profile-pypi-metadata.mjs` profiles a deterministic 10,424-wheel
fixture on the host. Add `--fixture` to emit its JSON for browser or guest
replays. `fixtures/pypi-project.mjs` also exports the fixture for browser use.
These CPU profiles do not measure package-install speed.

## Persistence

The container's writable layer lives on a disk, not in RAM. QEMU attaches
`/kdisk/disk.qcow2` as `/dev/vdb`: a 16 GiB ext4 filesystem in a qcow2 image.
After the snapshot restores, the patched c2w init mounts it at `/run/kdisk`
and points the overlay's `upperdir` and `workdir` into it. overlayfs rejects the
two on separate mounts, so they are subdirectories of the one disk mount. The
init mounts that exact overlay once as a probe; on any failure the layers stay
on tmpfs. The overlay therefore mounts after the restore, not before it, and
`/tmp` stays tmpfs.

Two modes, chosen by the page:

| Mode | Backing | Survives the tab | When |
|---|---|---|---|
| Persistent | `karkhana-disk/disk.qcow2` in OPFS | yes | default |
| Scratch | in-memory template copy, left unmounted; the upper layer stays tmpfs | no | `?disk=scratch`, a second tab, no OPFS sync handles |

`disk/opfs-disk.js` mounts a one-file Emscripten filesystem at `/kdisk`.
QEMU's file syscalls reach the page's main thread, which cannot use OPFS sync
handles or block. A module worker (`disk/opfs-disk-worker.js`) holds the
handle; the main thread passes each request through shared memory and spins.
Chrome measured 11 µs per 4 KiB read round trip. The guest's fsync reaches the
mount's `syncfs` and flushes OPFS; otherwise the worker flushes 1 s after the
last write. A closed tab loses at most ext4's 5 s commit interval.

qcow2 keeps the disk sparse by format. OPFS quota counts a file's logical
length, so a raw sparse image would bill all 16 GiB. A new disk starts from
`kdisk.qcow2.gz`, built in `Dockerfile.builder`: 6.4 MiB, 46 KB compressed.
The worker writes it to `disk.qcow2.part` and renames it only once complete.

The snapshot is baked with the template attached at the same path, so the
device exists on restore. The guest drops the block cache (`BLKFLSBUF`) before
mounting, because the restored kernel may still hold the template's blocks.
The template and runtime disk must keep the same 16 GiB virtual size.

A second tab cannot open the disk; OPFS grants one sync handle per file. After
3 s of retries it boots in scratch mode, and the header says so. The retry
covers a reload, where the previous page can still hold the handle.

`ksave`/`krestore` remain for scratch sessions. A persistent boot does not
stage `state.tar`, because restoring it would roll the disk back. The one
exception is the boot that creates a disk: it restores an existing
`state.tar` once and renames it `state.tar.migrated`.
`karkhana.persist.forget()` in the console clears the saved archive.
`karkhana.disk` reports the mode, the fallback reason, and I/O counters.
`karkhana.disk.forget()` deletes the disk; the reload creates a new one.

## AI (naklios two-tier)

⚙ panel: GP tier → on-device Gemini Nano when available (`builtin:nano`);
agent tier → BYOK endpoint (key stays in the browser; SW injects it at
`api.karkhana.internal`). In-guest `agent "task"` speaks OpenAI protocol.

## Known issues

- **Terminal waits:** the carried xterm-pty patch honors `O_NONBLOCK`, checks
  buffered input before registering a waiter, and uses an unsigned atomic index
  on the 3000 MB heap. The builder patches the library before linking; the
  shipped `out.js` carries the same changes. Run `node qemu-build/test-pty.mjs`
  from the repo root after editing either copy. These defects can stall or crash
  QEMU's I/O thread; they do not alone establish the cause of every observed freeze.

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
- **Modern x64 CPU features:** the builder uses
  `qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,+aes,+pclmulqdq`
  for both native snapshot creation and browser restoration. This exposes
  x86-64-v2 plus the AES and carry-less multiply instructions. The default
  `qemu64` omits features required by Bun and OpenCode's baseline binaries.
  The carried Wasm POPCNT correction fixes incorrect operand indexes and
  zero-extends 32-bit results into the backend's 64-bit register globals.
  Without that correction, enabling POPCNT crashes Go's container init.
  Do not change only the published runtime arguments; rebuild the snapshot
  with the same CPU flags. Compatibility checks belong on both cold boots
  and snapshot restores, including real Bun evaluation and OpenCode startup.
  Run `node qemu-build/test-cpu.mjs /path/to/qemu-wasm` from the repository
  root with a local checkout containing the pinned QEMU commit. The test
  applies the builder's exact patch to a temporary copy, compiles its C
  emitters, then executes their Wasm output against known and randomized inputs.
- **Guest RAM ceiling:** QEMU limits 32-bit hosts to 2047M guest RAM.
  The current 1792M guest leaves room for QEMU inside the fixed 3000M Wasm heap.
- **Entropy: FIXED** — carried kernel patch adds CONFIG_HW_RANDOM_VIRTIO +
  `-device virtio-rng-pci`; crng init at ~2.4 guest-seconds (was 90-560 s).
  TLS entropy stalls (git/node first-use hangs) are gone.

## Investigating a VM freeze

Use a disposable browser origin so the run cannot replace saved user state.
Keep the tab visible and avoid concurrent Docker builds or compression jobs.
Record host load; do not compare timing runs taken under different host loads.

Run long commands in the background with output redirected to one log. Poll
with `tail` or `stat` on that file, at most once per minute. Never use `du`,
recursive `find`, or cache-directory walks as progress probes: these add minutes
of guest work under TCG. A quiet terminal alone is not evidence of a frozen VM.

For independent liveness evidence, pre-create a small file under `/persist`
through `Module.FS`, then have a guest background loop update it every ten seconds.
Read that file through `Module.FS` without sending terminal commands. Record its
last change, queued PTY bytes, worker errors, and whether a fresh terminal marker
returns. A stopped heartbeat means guest execution or its I/O path has stalled;
use network replies and worker stacks to distinguish those cases. Save evidence
before reloading, since reload destroys this VM.
