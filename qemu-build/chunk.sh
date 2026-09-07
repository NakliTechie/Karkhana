#!/usr/bin/env bash
# Stage a built engine for publishing: split oversized files into parts and
# write engine-manifest.json, then lay out the page assets beside them.
#
# Why parts: Cloudflare Pages refuses to serve any file over 25 MB, and the
# repo is the only artifact store (no R2, no external hosting). The page
# reassembles the parts into Blobs and caches the result.
#
#   ./chunk.sh [src_htdocs] [staging_dir]
# defaults: out/htdocs -> publish/
set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-out/htdocs}"
STAGE="${2:-publish}"
CHUNK_BYTES=$((20 * 1024 * 1024))   # 20 MB, comfortably under the 25 MB cap

[ -d "$SRC" ] || { echo "FATAL: no build output at $SRC — run ./build.sh first"; exit 1; }

echo "==> staging $SRC -> $STAGE (chunk at $((CHUNK_BYTES / 1024 / 1024)) MB)"
rm -rf "$STAGE"
mkdir -p "$STAGE/engine"

# Page assets travel whole. karkhana.html is the single source for both the
# local (direct) and published (chunked) modes — it picks by probing for the
# manifest at runtime, so nothing is rewritten here.
for f in karkhana.html load.js out.js arg-module.js karkhana-sw.js c2w-net-proxy.wasm.gzip; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$STAGE/$f"
done
for d in vendor dist; do
    [ -d "$SRC/$d" ] && cp -R "$SRC/$d" "$STAGE/$d"
done

# Everything above the cap gets split; the manifest records order and size so
# the page can show real progress and verify what it assembled.
python3 - "$SRC" "$STAGE" "$CHUNK_BYTES" <<'PY'
import json, os, sys

src, stage, chunk = sys.argv[1], sys.argv[2], int(sys.argv[3])
manifest = {}

for name in sorted(os.listdir(src)):
    path = os.path.join(src, name)
    if not os.path.isfile(path):
        continue
    size = os.path.getsize(path)
    if size <= chunk:
        continue
    # A .gzip sibling means that is the form the page actually fetches; the raw
    # file is a build intermediate (c2w-net-proxy.wasm is the case today).
    # Chunking it would add tens of MB of parts nothing ever downloads.
    if os.path.exists(path + ".gzip"):
        print(f"    {name}: skipped, {name}.gzip is the shipped form")
        continue

    parts = []
    # aa, ab, ac ... matching `split -d` conventions the old layout used
    with open(path, "rb") as fh:
        i = 0
        while True:
            buf = fh.read(chunk)
            if not buf:
                break
            suffix = chr(ord("a") + i // 26) + chr(ord("a") + i % 26)
            part = f"{name}.part{suffix}"
            with open(os.path.join(stage, "engine", part), "wb") as out:
                out.write(buf)
            parts.append(part)
            i += 1

    manifest[name] = {"parts": parts, "size": size}
    print(f"    {name}: {size / 1048576:.0f} MB -> {len(parts)} parts")

if not manifest:
    print("FATAL: nothing exceeded the chunk size — is this a real build?", file=sys.stderr)
    sys.exit(1)

with open(os.path.join(stage, "engine", "engine-manifest.json"), "w") as fh:
    json.dump(manifest, fh, indent=1)

total = sum(f["size"] for f in manifest.values())
print(f"    manifest: {len(manifest)} files, {total / 1048576:.0f} MB total")
PY

# Reassembly check: the parts must rebuild the original byte for byte. A
# publish that ships a corrupt engine costs a 640 MB force-push to undo.
echo "==> verifying reassembly"
python3 - "$SRC" "$STAGE" <<'PY'
import hashlib, json, os, sys

src, stage = sys.argv[1], sys.argv[2]
manifest = json.load(open(os.path.join(stage, "engine", "engine-manifest.json")))

for name, meta in manifest.items():
    want = hashlib.sha256(open(os.path.join(src, name), "rb").read()).hexdigest()
    h = hashlib.sha256()
    got = 0
    for part in meta["parts"]:
        buf = open(os.path.join(stage, "engine", part), "rb").read()
        h.update(buf)
        got += len(buf)
    assert got == meta["size"], f"{name}: manifest says {meta['size']}, parts hold {got}"
    assert h.hexdigest() == want, f"{name}: reassembled bytes differ from the original"
    print(f"    {name}: sha256 matches across {len(meta['parts'])} parts")
PY

echo "==> staged. $(du -sh "$STAGE" | cut -f1) in $STAGE/ — publish with ./publish.sh"
