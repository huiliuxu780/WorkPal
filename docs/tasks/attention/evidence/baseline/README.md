# ATTENTION-01 基线与环境

- 分支：`codex/attention-01`
- 基线：`e3b22db`（其 tree = `origin/main` @ `4767b3c` 的 tree `8bfa4c9`）
  - 开分支时 github.com 暂时不可达，`origin/main` 还停在 `f95130d`；四壳已合入 main（merge commit `4767b3c` 的父为 `f95130d + e3b22db`），因此以内容等价且为 main 祖先的 `e3b22db` 为基，避免叠在四壳分支上产生多余 diff。
- 生成物：`pnpm --filter @rakazo/db generate`（已 gitignore）

## 本地验证环境

- PostgreSQL 16 由 testcontainers 起一次性实例；Docker 走 colima：
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`
  `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`
- e2e runtime：`--runtime=scripted`
- 卡片 gate：`CARDS_UNIFIED_V2_ENABLED=true` 由 harness 对 `card-attention.spec.ts` 自动开启（该 spec 在 `E2E_GATE_SPECS` 内）

## 复现

```bash
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
DOCKER_HOST=... pnpm test:e2e --runtime=scripted --spec="card-attention.spec.ts"
```
