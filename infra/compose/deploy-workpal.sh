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

# Layer order matters: prod base, then local-Docker computers, then AgentScope.
COMPOSE='docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  -f infra/compose/docker-compose.prod.agentscope.yml'

remote() { ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$ECS_HOST" "cd ${APP_DIR} && $*"; }

healthy() { curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; }

poll_health() {
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if healthy; then return 0; fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

rollback() {
  trap - ERR
  echo "Rolling back: restoring snapshot /srv/workpal-rollback.tar.gz." >&2
  remote "tar -xzf /srv/workpal-rollback.tar.gz -C /srv"
  # Rebuild from restored sources without contacting registries (mirrorbuilder
  # cache + prior image layers make this far faster than the failed build).
  remote "timeout --kill-after=30s ${BUILD_TIMEOUT} ${COMPOSE} up -d --build --pull never"
  if poll_health; then
    echo "Rollback complete: production is healthy at the previous revision."
  else
    echo "ROLLBACK ALSO FAILED HEALTH CHECK. Investigate manually: ssh -i ${SSH_KEY} ${ECS_HOST}" >&2
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
remote "tar --exclude=.git -czf /srv/workpal-rollback.tar.gz -C /srv workpal"
echo "Remote tree snapshotted to /srv/workpal-rollback.tar.gz."

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
trap rollback ERR
remote "GIT_SHA=${stamp} timeout --kill-after=30s ${BUILD_TIMEOUT} ${COMPOSE} up -d --build --pull never"

if poll_health; then
  trap - ERR
  remote "printf '%s\n' '${stamp}' > .last-deployed-revision"
  echo "Deployed ${stamp}; ${HEALTH_URL} is healthy."
  exit 0
fi

echo "Production did not become healthy in time." >&2
rollback
