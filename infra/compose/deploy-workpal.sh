#!/usr/bin/env bash
# Publish this repository's working tree to the WorkPal production ECS
# (APP_DIR on the host given by ECS_HOST) and rebuild it in place.
#
# Flow: disk guard -> remote tree snapshot -> rsync -> compose config ->
#       three-file compose up --build -> health poll -> auto-rollback on failure.
#
# Run this from the Mac after the local dev stack passed. The remote-only files
# (.env, Caddyfile.ip-http, .git) are excluded from rsync and never deleted;
# everything else is kept identical to the local tree (--delete).
#
# Only the deployment topology is scripted; host prerequisites are already
# permanent on the server: buildx builder `mirrorbuilder` selected,
# registry-mirrors in daemon.json, DEBIAN_MIRROR + relaxed image tags in .env.
set -Eeuo pipefail

# Required, no defaults: never commit a real host, URL or key path.
: "${ECS_HOST:?ECS_HOST is required (e.g. root@<server-ip>)}"
: "${SSH_KEY:?SSH_KEY is required (path to the SSH private key)}"
: "${HEALTH_URL:?HEALTH_URL is required (e.g. http://<server-ip>/health)}"
APP_DIR="${APP_DIR:-/srv/workpal}"
MIN_FREE_MB="${MIN_FREE_MB:-4096}"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-30m}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

[[ -f "$SSH_KEY" ]] || { echo "SSH key not found: $SSH_KEY" >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The snapshot follows APP_DIR so a rehearsal deployment (APP_DIR=/srv/workpal-dr)
# never shares prod's rollback archive, and rollback always restores the exact
# tree the rsync replaced. Defaults keep the historical prod paths byte-identical.
APP_PARENT="$(dirname "$APP_DIR")"
APP_BASE="$(basename "$APP_DIR")"
ROLLBACK_TAR="${ROLLBACK_TAR:-${APP_PARENT}/${APP_BASE}-rollback.tar.gz}"

# Layer order matters: prod base, then local-Docker computers, then AgentScope.
COMPOSE='docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  -f infra/compose/docker-compose.prod.agentscope.yml'

remote() { ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$ECS_HOST" "cd ${APP_DIR} && $*"; }
remote_nocd() { ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$ECS_HOST" "$*"; }

healthy() { curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; }

poll_health() {
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if healthy; then return 0; fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

have_snapshot=0
rollback() {
  trap - ERR
  if (( ! have_snapshot )); then
    echo "Rollback impossible: ${APP_DIR} did not exist before this deploy, so no snapshot was taken." >&2
    echo "The half-synced tree and any containers this attempt started are left in place for inspection." >&2
    exit 1
  fi
  echo "Rolling back: restoring snapshot ${ROLLBACK_TAR} into ${APP_DIR} (wholesale tree replacement)." >&2
  # The restore helper must not come from the remote tree (it may be half-updated);
  # ship this checkout's copy next to the snapshot, then run it. The helper
  # replaces the directory wholesale, so files rsync ADDED are removed, and it
  # leaves APP_DIR untouched (with a loud error) if the snapshot is unusable.
  restore_helper="${ROLLBACK_TAR}.restore.sh"
  if ! ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$ECS_HOST" \
      "cat > '${restore_helper}'" < "${REPO_DIR}/infra/compose/restore-deploy-snapshot.sh"; then
    echo "SNAPSHOT RESTORE FAILED: could not stage the restore helper on the host." >&2
    echo "${APP_DIR} still holds the failed deploy's tree; the stack may be down." >&2
    echo "Manual path: ssh -i ${SSH_KEY} ${ECS_HOST} and restore ${ROLLBACK_TAR} by hand." >&2
    exit 1
  fi
  if ! remote_nocd "bash '${restore_helper}' '${ROLLBACK_TAR}' '${APP_DIR}'"; then
    echo "SNAPSHOT RESTORE FAILED: ${APP_DIR} was left untouched; the stack may be down or on the failed revision." >&2
    echo "Verify ${ROLLBACK_TAR} and restore manually (backups: /var/backups/rakazo): ssh -i ${SSH_KEY} ${ECS_HOST}" >&2
    exit 1
  fi
  # Rebuild from restored sources without contacting registries (mirrorbuilder
  # cache + prior image layers make this far faster than the failed build).
  if remote "timeout --kill-after=30s ${BUILD_TIMEOUT} ${COMPOSE} up -d --build --pull never"; then
    if poll_health; then
      echo "Rollback complete: production is healthy at the previous revision."
    else
      echo "ROLLBACK ALSO FAILED HEALTH CHECK. Investigate manually: ssh -i ${SSH_KEY} ${ECS_HOST}" >&2
    fi
  else
    echo "ROLLBACK REBUILD FAILED: ${ROLLBACK_TAR} was restored to ${APP_DIR}, but 'up --build' did not succeed." >&2
    echo "Previous-revision sources are in place; the stack may be down. Inspect build/container logs: ssh -i ${SSH_KEY} ${ECS_HOST}" >&2
  fi
  exit 1
}

# --- preflight ---------------------------------------------------------------
revision="$(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "${REPO_DIR}" status --porcelain 2>/dev/null)" ]]; then
  stamp="${revision}-dirty"
  echo "WARNING: local working tree has uncommitted changes; deploying as ${stamp}." >&2
else
  stamp="${revision}"
fi

free_mb="$(remote "df --output=avail -m / | tail -1")"
if (( free_mb < MIN_FREE_MB )); then
  echo "ECS root disk has only ${free_mb} MB free (< ${MIN_FREE_MB})." >&2
  echo "Free space first, e.g.: docker builder prune -f && docker image prune -f" >&2
  exit 1
fi
echo "ECS reachable, ${free_mb} MB free, deploying ${stamp}."

# --- snapshot, then sync -----------------------------------------------------
# Arm the rollback trap from the snapshot onward: an rsync or `compose config`
# failure leaves a half-updated remote tree, which must roll back too — not only
# a failed `up`.
if remote_nocd "test -d '${APP_DIR}'"; then
  remote_nocd "tar --exclude=.git -czf '${ROLLBACK_TAR}' -C '${APP_PARENT}' '${APP_BASE}'"
  have_snapshot=1
  echo "Remote tree snapshotted to ${ROLLBACK_TAR}."
  trap rollback ERR
else
  echo "First deploy: ${APP_DIR} does not exist yet; failures before 'up' cannot roll back." >&2
fi

rsync -az --delete \
  --exclude .git \
  --exclude .env \
  --exclude node_modules \
  --exclude 'infra/compose/Caddyfile.ip-http' \
  -e "ssh -i ${SSH_KEY} -o BatchMode=yes" \
  "${REPO_DIR}/" "${ECS_HOST}:${APP_DIR}/"
echo "Tree synced to ${ECS_HOST}:${APP_DIR}."

# --- build and start -----------------------------------------------------------
# GIT_SHA stamps the running images; the environment beats --env-file here.
# .env already supplies DEBIAN_MIRROR / RAKAZO_ALLOW_DEV_SECRETS / image tags,
# and prod compose declares name: rakazo-prod, so no -p is needed.
remote "${COMPOSE} config --quiet"
remote "GIT_SHA=${stamp} timeout --kill-after=30s ${BUILD_TIMEOUT} ${COMPOSE} up -d --build --pull never"

if poll_health; then
  trap - ERR
  remote "printf '%s\n' '${stamp}' > .last-deployed-revision"
  echo "Deployed ${stamp}; ${HEALTH_URL} is healthy."
  exit 0
fi

echo "Production did not become healthy in time." >&2
rollback
