#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

V86_TOOLS="../../v86-build/tools"
OUT_DIR="../alpine-out"
OUT_ROOTFS_TAR="$OUT_DIR/alpine-rootfs.tar"
OUT_ROOTFS_FLAT="$OUT_DIR/alpine-rootfs-flat"
OUT_FSJSON="$OUT_DIR/alpine-fs.json"
CONTAINER_NAME=karkhana-alpine
IMAGE_NAME=i386/karkhana-alpine

mkdir -p "$OUT_DIR"

echo "==> Building Docker image (i386)..."
docker build . --platform linux/386 --rm --tag "$IMAGE_NAME"

echo "==> Creating container..."
docker rm "$CONTAINER_NAME" 2>/dev/null || true
docker create --platform linux/386 -t -i --name "$CONTAINER_NAME" "$IMAGE_NAME"

echo "==> Exporting rootfs..."
docker export "$CONTAINER_NAME" -o "$OUT_ROOTFS_TAR"
tar -f "$OUT_ROOTFS_TAR" --delete ".dockerenv" 2>/dev/null || true

echo "==> Generating fs.json..."
python3 "$V86_TOOLS/fs2json.py" --zstd --out "$OUT_FSJSON" "$OUT_ROOTFS_TAR"

echo "==> Copying to sha256-named flat files..."
mkdir -p "$OUT_ROOTFS_FLAT"
python3 "$V86_TOOLS/copy-to-sha256.py" --zstd "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT"

echo ""
echo "==> Done!"
echo "    Rootfs tar: $OUT_ROOTFS_TAR"
echo "    Flat files: $OUT_ROOTFS_FLAT"
echo "    FS JSON:    $OUT_FSJSON"
echo ""
echo "    Copy alpine-fs.json and alpine-rootfs-flat/ to your Karkhana images/ directory."

docker rm "$CONTAINER_NAME" 2>/dev/null || true
