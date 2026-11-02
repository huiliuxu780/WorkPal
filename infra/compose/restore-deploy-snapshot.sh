#!/usr/bin/env bash
# Restore a deploy-workpal.sh snapshot over APP_DIR, replacing the directory
# wholesale so files ADDED by the failed deploy are removed instead of merged
# over (a plain `tar -x` into the live tree leaves them behind). Runs on the
# ECS host:  restore-deploy-snapshot.sh SNAPSHOT_TAR APP_DIR
#
# The snapshot is the tarball deploy-workpal.sh creates before rsync:
#   tar --exclude=.git -czf <parent>/<base>-rollback.tar.gz -C <parent> <base>
# The live .git (never in snapshots) is carried into the restored tree.
# The restore is staged: on any failure APP_DIR is left exactly as it was.
set -Eeuo pipefail

SNAPSHOT="${1:?usage: restore-deploy-snapshot.sh SNAPSHOT_TAR APP_DIR}"
APP_DIR="${2:?usage: restore-deploy-snapshot.sh SNAPSHOT_TAR APP_DIR}"

fail() { echo "restore: $*" >&2; exit 1; }

[[ -f "$SNAPSHOT" ]] || fail "snapshot file not found: $SNAPSHOT"
[[ -d "$APP_DIR" ]] || fail "APP_DIR does not exist: $APP_DIR"

parent="$(dirname "$APP_DIR")"
base="$(basename "$APP_DIR")"
staging="${parent}/.${base}.restore-staging.$$"
old="${parent}/.${base}.restore-old.$$"
[[ -e "$staging" || -e "$old" ]] && fail "stale staging/old directories present; refusing to run"

cleanup() { rm -rf "$staging" "$old" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$staging"
tar -xzf "$SNAPSHOT" -C "$staging" || fail "could not extract $SNAPSHOT (corrupt or truncated archive?)"
[[ -d "${staging}/${base}" ]] || fail "snapshot does not contain a ${base}/ tree"
# Sanity-check against a half-written or wrong-directory archive before swapping.
[[ -f "${staging}/${base}/infra/compose/docker-compose.prod.yml" ]] \
  || fail "snapshot tree failed sanity check (missing infra/compose/docker-compose.prod.yml)"

# Snapshots exclude .git; carry the live one over so remote history survives.
if [[ -d "${APP_DIR}/.git" ]]; then
  mv "${APP_DIR}/.git" "${staging}/${base}/.git" || fail "could not preserve ${APP_DIR}/.git"
fi

# Same-filesystem swap; if the second move fails, undo the first.
mv "$APP_DIR" "$old" || fail "could not move aside the live tree at $APP_DIR"
if ! mv "${staging}/${base}" "$APP_DIR"; then
  mv "$old" "$APP_DIR" || fail "CRITICAL: swap failed and undo failed; tree is at ${old}"
  fail "directory swap failed; ${APP_DIR} left in its pre-restore state"
fi

echo "restore: ${APP_DIR} replaced from ${SNAPSHOT} (files added by the failed deploy removed; .git preserved)."
