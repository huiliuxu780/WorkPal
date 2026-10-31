# BADGES-01 基线与环境

- 分支：`codex/badges-01`
- 基线：`origin/main` @ `068f0ea`（ATTENTION-01 合入后的 main）
- 生成物：`pnpm --filter @rakazo/db generate`（已 gitignore）

## 本地验证环境

- PostgreSQL 16 由 testcontainers 起一次性实例；Docker 走 colima：
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`
- e2e runtime：`--runtime=scripted`
- 卡片 gate：`CARDS_UNIFIED_V2_ENABLED=true`，由 harness 对 `card-attention.spec.ts` / `peer-messages.spec.ts` 自动开启

## 复现

```bash
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
DOCKER_HOST=... pnpm test:e2e --runtime=scripted --spec="group-chats.spec.ts|ui-appearance.spec.ts"
DOCKER_HOST=... pnpm test:e2e --runtime=scripted --spec="card-attention.spec.ts|peer-messages.spec.ts"
```
