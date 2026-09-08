#!/usr/bin/env bash
# Publish a staged engine to the repo root — what karkhana.naklitechie.com serves — and push it.
#
# The repo is the only artifact store, so an engine update REPLACES history
# rather than accumulating: 640 MB of superseded parts in the log would make
# the clone unusable within a few releases. That means a force-push, which is
# why this script confirms before it does anything irreversible.
#
#   ./publish.sh [staging_dir]        # default: publish/
#   ./publish.sh --dry-run            # stage into next/, show the diff, stop
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
DEST="$REPO_ROOT"

# The paths an engine publish owns at the apex. Named explicitly because DEST is
# the repo root: a blanket rm -rf here would take the whole working tree with it.
OWNED=(engine dist vendor index.html karkhana-sw.js load.js out.js
       arg-module.js c2w-net-proxy.wasm.gzip)
DRY=false
STAGE="publish"

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY=true ;;
        *) STAGE="$arg" ;;
    esac
done

[ -d "$STAGE" ] || { echo "FATAL: no staging dir at $STAGE — run ./chunk.sh first"; exit 1; }
[ -f "$STAGE/engine/engine-manifest.json" ] || { echo "FATAL: $STAGE has no engine manifest — chunk.sh did not finish"; exit 1; }

# The stale-cache trap: the service worker is cache-first for .wasm/.data/.gzip,
# so a browser that has the old engine keeps booting it after a republish. The
# cache name must change with the engine, or testers get yesterday's build and
# no error to explain it.
CACHE_VER="$(python3 -c "
import hashlib, json, sys
m = json.load(open('$STAGE/engine/engine-manifest.json'))
key = ''.join(f'{n}:{v[\"size\"]}' for n, v in sorted(m.items()))
print(hashlib.sha256(key.encode()).hexdigest()[:12])
")"
echo "==> engine id: $CACHE_VER"

if ! grep -q "karkhana-engine-$CACHE_VER" "$STAGE/karkhana.html" 2>/dev/null; then
    echo "==> stamping cache version into karkhana.html + karkhana-sw.js"
    sed -i '' "s/karkhana-engine-v1/karkhana-engine-$CACHE_VER/g" "$STAGE/karkhana.html"
    sed -i '' "s/karkhana-engine-v1/karkhana-engine-$CACHE_VER/g" "$STAGE/karkhana-sw.js" 2>/dev/null || true
fi

if ! grep -q "karkhana-engine-$CACHE_VER" "$STAGE/karkhana.html"; then
    echo "FATAL: cache version not stamped — the SW would serve the previous engine."
    echo "       Expected 'karkhana-engine-v1' in $STAGE/karkhana.html to rewrite."
    exit 1
fi

echo "==> replacing the published tree at $DEST"
for path in "${OWNED[@]}"; do rm -rf "${DEST:?}/$path"; done
cp -R "$STAGE"/. "$DEST"/
# the staged page is karkhana.html; at the apex it is the index
mv "$DEST/karkhana.html" "$DEST/index.html"

cd "$REPO_ROOT"
git add -A
echo
git diff --cached --stat | tail -5
echo

if $DRY; then
    echo "==> dry run. the published tree is staged in the index; nothing committed or pushed."
    exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SUBJECT="$(git log -1 --format=%s)"

# Only ever REPLACE a commit that is itself an engine publish. Amending anything
# else would rewrite unrelated work, and the engine blobs make that unrecoverable
# for anyone who already pulled.
if [[ "$HEAD_SUBJECT" == Engine\ * ]]; then
    MODE=replace
    cat <<WARN
==> REPLACE: the tip is already an engine publish ($HEAD_SUBJECT).

    Amending it and force-pushing drops the superseded 640 MB of parts out of
    the repo entirely. Anyone holding the old commit must re-clone or reset
    --hard. This is the intended discipline: engines replace, never accumulate.

WARN
    read -r -p "Type REPLACE to continue: " CONFIRM
    [ "$CONFIRM" = "REPLACE" ] || { echo "aborted — the published tree is staged but not committed"; exit 1; }
else
    MODE=new
    cat <<WARN
==> NEW COMMIT: the tip is not an engine publish, so nothing is being rewritten.

    tip: $HEAD_SUBJECT

    The previous engine's parts stay in history behind this commit. That is
    safe but it accumulates; squash the older engine commit out when the clone
    starts to hurt. Publishing again on top of THIS commit will replace it.

WARN
    read -r -p "Type PUBLISH to continue: " CONFIRM
    [ "$CONFIRM" = "PUBLISH" ] || { echo "aborted — the published tree is staged but not committed"; exit 1; }
fi

if [ "$MODE" = replace ]; then
    git commit -q --amend -m "Engine $CACHE_VER"
    git push --force-with-lease origin "$BRANCH"
else
    git commit -q -m "Engine $CACHE_VER"
    git push origin "$BRANCH"
fi

echo "==> published engine $CACHE_VER to origin/$BRANCH ($MODE)"
echo "    Cloudflare Pages deploys on push; give it a few minutes, then live-check."
