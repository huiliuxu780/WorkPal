FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS build
RUN corepack enable
WORKDIR /app
# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @rakazo/db generate
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
# The build stage legitimately holds the whole repository. Only what this step
# allows reaches the runtime stage, so repository control documents, task and
# evidence docs, Java sources, dev tooling and test sources stay behind.
RUN node infra/compose/collect-runtime-tree.mjs /app /runtime

FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS runtime
RUN corepack enable
WORKDIR /app
# Both trees were created inside the build stage as root with the default umask,
# so they are already readable by USER node; no host-umask normalization needed.
COPY --from=build /runtime /app
# The dependency store is copied separately from the pruned sources: it is the
# one part of the build stage too large to assemble twice.
COPY --from=build /app/node_modules /app/node_modules
# `corepack enable` only installs a shim. Without prepare, the first pnpm
# invocation downloads the package manager at runtime — which the build stage
# used to hide because it installed and ran in the same layer, and which a
# production network will not allow. The version comes from package.json so it
# cannot drift from the lockfile.
RUN corepack prepare "$(node -p "require('/app/package.json').packageManager")" --activate
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp
ARG GIT_SHA
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]
