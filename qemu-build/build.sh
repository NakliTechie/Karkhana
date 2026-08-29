#!/usr/bin/env bash
# Build a modern 64-bit Debian userland into a qemu-wasm browser bundle.
# Reuses beagle's proven qemu-wasm builder Dockerfile + c2w converter,
# WITHOUT modifying beagle's repo (read-only references into it).
set -euo pipefail
cd "$(dirname "$0")"

BEAGLE="/Users/chiragpatnaik/Code/beagle"
C2W="$BEAGLE/vendor/container2wasm/out/c2w"
DOCKERFILE="$BEAGLE/patches/Dockerfile.beagle"
IMG="karkhana-debian:amd64"
OUT="$(pwd)/out/htdocs/"

[ -x "$C2W" ] || { echo "FATAL: c2w not found at $C2W"; exit 1; }
[ -f "$DOCKERFILE" ] || { echo "FATAL: beagle builder Dockerfile not found at $DOCKERFILE"; exit 1; }

echo "==> [1/2] Building guest OCI image ($IMG): debian:12-slim + python3 + nodejs …"
docker build --platform linux/amd64 -f Dockerfile.guest -t "$IMG" .

echo "==> [2/2] c2w: converting $IMG to qemu-wasm (amd64) …"
mkdir -p "$OUT"
"$C2W" --to-js --target-arch=amd64 \
  --dockerfile "$DOCKERFILE" \
  --build-arg SOURCE_REPO_VERSION=main \
  --build-arg VM_MEMORY_SIZE_MB=1024 \
  --build-arg LINUX_LOGLEVEL=7 \
  --build-arg QEMU_MIGRATION=true \
  "$IMG" "$OUT"

echo "==> Done. Artifacts in $OUT :"
ls -la "$OUT"

echo "==> Installing Karkhana console page + vendored terminal assets…"
cp "$(pwd)/karkhana.html" "$OUT/karkhana.html"
cp -R "$(pwd)/vendor" "$OUT/vendor"
echo "==> Serve: python3 serve.py 8793 (from qemu-build/) then open http://127.0.0.1:8793/karkhana.html"

echo "==> Building network stack (c2w-net-proxy + in-page gvisor stack)…"
( cd "$(dirname "$0")/net/c2w-net-proxy" && GOOS=wasip1 GOARCH=wasm go build -o "$OUT/c2w-net-proxy.wasm" . )
gzip -kf "$OUT/c2w-net-proxy.wasm" && mv "$OUT/c2w-net-proxy.wasm.gz" "$OUT/c2w-net-proxy.wasm.gzip"
( cd "$(dirname "$0")/net/stack" && npm install --no-audit --no-fund && npx webpack )
mkdir -p "$OUT/dist"
cp "$(dirname "$0")/net/stack/dist/stack.js" "$(dirname "$0")/net/stack/dist/stack-worker.js" "$OUT/dist/"
cp "$(dirname "$0")/karkhana-sw.js" "$OUT/karkhana-sw.js"
