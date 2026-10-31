# FOUR-SHELLS-01 基线与环境

- 分支：`codex/four-shells-01`（本地交付，未推远程）
- 基线：`origin/main` @ `f95130d01b14653ff33908fa03757cb552cf9773`
  - 已含 CHAT-CHROME-01（PR #159）：内容列 704、`ArtifactPageCard`、artifact family 投影、C3 开最新
- 工作区：独立 worktree，开工时 `git status` 干净
- 生成物：`pnpm --filter @rakazo/db generate`（`packages/db/src/generated` 已 gitignore，不随分支提交）

## 本地验证环境

- pnpm（仓库锁定）；Node 22（本机）
- PostgreSQL 16 由 testcontainers 起一次性实例；Docker 走 colima，需显式：
  `DOCKER_HOST=unix:///Users/rivers/.colima/default/docker.sock`
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`
- e2e runtime：`--runtime=scripted`（确定性夹具，无真实模型）
- 卡片 gate：`CARDS_UNIFIED_V2_ENABLED=true`，由 `packages/testkit/src/cli/harness.ts` 对 gated spec 自动开启；
  `four-shells-visual.spec.ts` 已登记进 `E2E_GATE_SPECS`

## 复现命令

```bash
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
DOCKER_HOST=... pnpm test:e2e --runtime=scripted \
  --spec="card-ui-interactions.spec.ts|card-display-content.spec.ts|four-shells-visual.spec.ts"
DOCKER_HOST=... pnpm test:e2e --runtime=scripted \
  --spec="choice-card.spec.ts|plan-review.spec.ts|computer-needs-you-card.spec.ts"
```
