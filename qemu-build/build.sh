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
  --build-arg QEMU_MIGRATION=false \
  "$IMG" "$OUT"

echo "==> Done. Artifacts in $OUT :"
ls -la "$OUT"
