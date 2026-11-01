# REPORT-01 基线与环境

- 分支：`codex/report-01`
- 基线：`origin/main` @ `6dcc620`
- 生成物：`pnpm --filter @rakazo/db generate`（已 gitignore）
- 新迁移：`20261101120000_delivery_result_message`（`delivery_records.resultMessageId`）

## 本地验证环境

- PostgreSQL 16 由 testcontainers 起一次性实例；Docker 走 colima：
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`
- `result-delivery.postgres.test.ts` **直连源库**（不是隔离克隆），跑前需对目标库执行 `prisma migrate deploy`
- e2e：`--runtime=scripted`；`report-delivery.spec.ts` 不依赖卡片 gate

## 复现

```bash
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
VERIFY_DATABASE=1 DATABASE_URL=... pnpm exec vitest run \
  packages/adapters/src/result-delivery.postgres.test.ts \
  apps/api/src/report-envelope.postgres.test.ts
DOCKER_HOST=... pnpm test:e2e --runtime=scripted --spec="report-delivery.spec.ts"
```
