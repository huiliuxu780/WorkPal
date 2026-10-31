#!/usr/bin/env bash
# Regression for restore-deploy-snapshot.sh, the rollback restore used by
# deploy-workpal.sh: a restore must REMOVE files the failed deploy added (a
# plain `tar -x` over the live tree leaves them behind), revert modified
# files, preserve the live .git, and fail loudly without touching APP_DIR
# when the snapshot is unusable. Bash-only; no Docker, no network.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
helper="${root}/restore-deploy-snapshot.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

bash -n "$helper"

# --- fixture: an "old deployed tree", snapshotted the way deploy-workpal.sh does
mkdir -p "${scratch}/srv/workpal/infra/compose" "${scratch}/srv/workpal/.git"
echo v1 > "${scratch}/srv/workpal/app.txt"
echo "name: rakazo-prod" > "${scratch}/srv/workpal/infra/compose/docker-compose.prod.yml"
echo gitdir > "${scratch}/srv/workpal/.git/HEAD"
tar --exclude=.git -czf "${scratch}/srv/workpal-rollback.tar.gz" -C "${scratch}/srv" workpal

# --- simulate a failed deploy: one modified file, one file rsync ADDED
echo v2 > "${scratch}/srv/workpal/app.txt"
echo leaked > "${scratch}/srv/workpal/leaked-from-new-revision.txt"

# --- case 1: restore replaces the tree wholesale
bash "$helper" "${scratch}/srv/workpal-rollback.tar.gz" "${scratch}/srv/workpal" >/dev/null
[[ "$(cat "${scratch}/srv/workpal/app.txt")" == v1 ]] || fail "modified file not restored"
[[ ! -e "${scratch}/srv/workpal/leaked-from-new-revision.txt" ]] || fail "file added by the failed deploy survived the restore"
[[ -f "${scratch}/srv/workpal/.git/HEAD" ]] || fail "live .git was not preserved"
[[ -f "${scratch}/srv/workpal/infra/compose/docker-compose.prod.yml" ]] || fail "compose file missing after restore"
ls "${scratch}/srv" | grep -q 'restore-' && fail "staging/old directories left behind"

# --- case 2: corrupt snapshot -> loud failure, APP_DIR untouched
echo v3 > "${scratch}/srv/workpal/app.txt"
printf 'not-a-tarball' > "${scratch}/srv/bad.tar.gz"
rc=0
bash "$helper" "${scratch}/srv/bad.tar.gz" "${scratch}/srv/workpal" >/dev/null 2>"${scratch}/case2.err" || rc=$?
[[ "$rc" -ne 0 ]] || fail "corrupt snapshot did not fail"
grep -q 'restore:' "${scratch}/case2.err" || fail "corrupt snapshot failed without an explicit restore: error"
[[ "$(cat "${scratch}/srv/workpal/app.txt")" == v3 ]] || fail "APP_DIR was modified despite the failed restore"
ls "${scratch}/srv" | grep -q 'restore-' && fail "staging directories left behind after failure"

# --- case 3: missing snapshot -> loud failure
rc=0
bash "$helper" "${scratch}/srv/nope.tar.gz" "${scratch}/srv/workpal" >/dev/null 2>"${scratch}/case3.err" || rc=$?
[[ "$rc" -ne 0 ]] || fail "missing snapshot did not fail"
grep -q 'not found' "${scratch}/case3.err" || fail "missing snapshot did not report 'not found'"

# --- case 4: an archive without the expected tree -> loud failure, APP_DIR untouched
mkdir -p "${scratch}/elsewhere" && echo x > "${scratch}/elsewhere/f.txt"
tar -czf "${scratch}/srv/wrong.tar.gz" -C "${scratch}" elsewhere
rc=0
bash "$helper" "${scratch}/srv/wrong.tar.gz" "${scratch}/srv/workpal" >/dev/null 2>"${scratch}/case4.err" || rc=$?
[[ "$rc" -ne 0 ]] || fail "wrong-content snapshot did not fail"
[[ "$(cat "${scratch}/srv/workpal/app.txt")" == v3 ]] || fail "APP_DIR was modified by a wrong-content restore"

echo "deploy-rollback smoke: all cases passed."
