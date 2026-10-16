# DEP-01 生产追平部署：准备与演练记录

状态：演练完成，实际 ECS 切换**待最终批准**。本文件为脱敏记录：不含主机地址、账号、密钥值或私有 URL；主机一律称"生产 ECS"。任务书见 `docs/tasks/DEP-01.md`。

## 基线与目标

| 项 | 值 |
| --- | --- |
| 目标提交（演练所用） | `main` @ `8d263ad4a2ee003646fcdbb07d8f66ed903209e3`（PR #47 合并，CI 6/6） |
| 生产现运行源码 | `b101d70`（2026-10-07 部署，远端 `.git/refs/heads/main` 证实） |
| 生产现运行 runtime | **Python** agentscope（镜像 `workpal/agentscope:local`，2026-10-07 构建）；仓库已于 b506405 删除该 runtime，**只能向前滚动，无法用当前仓库重建生产现状** |
| 演练分支 | `codex/dep01-deploy-rehearsal`（脚本修复×2 + 本文档）；`dep01-drill`（本地演练拓扑，**不合并**） |
| 记录日期 | 2026-10-16（UTC） |

## 1. 只读盘点（2026-10-16）

- 生产 ECS：4c/7.5G 内存/40G 盘；盘点时磁盘余量 5.9G（85%），内存 available 5.2G，无 swap。
- 容器（project `rakazo-prod`，目录 `/srv/workpal/infra/compose`）：postgres:16、caddy:2、app×4（api/worker/web/supervisor，共用 `ghcr.io/elie222/rakazo/app:local`，2026-10-07 构建）、agentscope（Python，`workpal/agentscope:local`）、computer 与 data-init 一次性容器（Exited 0）、一个已退出的 bot computer 容器。全部创建于 2026-10-07，从未成功重建。
- 数据库：PostgreSQL **16.15**；`_prisma_migrations` **90 行**（0 失败、0 回滚），最后应用 `20261007050303_avatar_style_bloub_default`。
- 业务数据（关键计数，恢复核对基准）：`messages=7 user=1 bots=1 threads=1 runs=4 tasks=4 events=49`；最后一条消息 2026-10-07 05:33 UTC。**生产闲置**。
- 持久卷：`pgdata`（68M）、`appdata`（7.7M，含 `agentscope-state`/`homes`/`home-revisions`，即旧 Python runtime 状态）、`caddydata`/`caddyconfig`（KB 级）；**不存在 `agentstate` 卷**（新 Java runtime 首次部署时才会创建）。另有已废弃 apboa 项目的卷（约 841M，按既有决定**保留不动**）。
- 部署痕迹：无 `.last-deployed-revision`、无 `/srv/workpal-rollback.tar.gz` → `deploy-workpal.sh` 从未对该主机运行过。
- 主机前提（均健在）：daemon.json `registry-mirrors=daocloud`；buildx `mirrorbuilder`（docker-container, host 网络）被选用；`.env` 含 `DEBIAN_MIRROR` 与放宽的镜像 tag。
- 网络可达性（主机侧实测）：`releases.astral.sh`、`github.com` release 下载、`repo.maven.apache.org` 均 200（<1.5s）；docker.io 直连不可达（必须走镜像源）。
- 生产 `.env` 变量名（仅名称）：API_URL、BETTER_AUTH_SECRET、BETTER_AUTH_URL、CADDYFILE_PATH、CADDY_IMAGE、CLOUD_AGENT_PROVIDER、DEBIAN_MIRROR、ENCRYPTION_KEY、GRAPHILE_WORKER_CONCURRENCY、NODE_ENV、POSTGRES_DB/IMAGE/PASSWORD/USER、RAKAZO_DEPLOY_DIR、RAKAZO_HOST、SANDBOX_SUPERVISOR_TOKEN、SCREEN_PROXY_SECRET、SIGNUPS_ENABLED、WAKEUP_DRIVER、WEB_ORIGIN。未设置 `RAKAZO_IMAGE*` 覆盖 → 生产使用默认镜像名。
- Caddy 路由（远端 `Caddyfile.ip-http`）：`:8080` 上 `/health`、`/api/*`、`/rpc/*` → api:3100，其余 → web:5173；主机发布 80/443/8080。

### 数据取舍决定（显式记录）

| 数据 | 决定 |
| --- | --- |
| `pgdata`（DB dump） | **必须可恢复**；已备份并在隔离环境恢复验证 |
| `appdata`（含旧 Python runtime 状态与 bot homes） | **必须可恢复**；已备份并解包核对 |
| 生产源码树 + `.env` | **必须可恢复**；已分别归档（`.env` 仅留在主机备份目录，600 权限，不出主机） |
| 旧镜像（app/computer/agentscope 的 `:local` tag） | **保留至验收结束**（回滚重建的层缓存与最后手段） |
| `caddydata`/`caddyconfig` | 已归档；HTTP-only 站点下价值低，可弃但恢复成本低 |
| apboa 遗留卷 | 保留（既有用户决定）；apboa 遗留**镜像**（mysql/redis/nginx/node:22-alpine，均无任何 Dockerfile 引用）已删除，连带 dangling 共回收 **9.4G**，磁盘余量 5.9G → **16G** |
| 主机临时 4G swapfile | 演练期新增（无 swap + 构建峰值有 OOM 风险波及生产容器）；未写入 fstab，验收后决定去留 |

## 2. 可恢复备份（2026-10-16）

主机备份目录 `/var/backups/rakazo/20261016T042900Z/`（在部署树之外，`deploy-workpal.sh` 的 rsync --delete 不会触碰；backup-prod.sh 保留策略只删 >6 天的快照，验收在窗口内）：

| 文件 | 大小 | sha256（前 12 位） |
| --- | --- | --- |
| `rakazo.dump`（pg_dump custom, 16 服务端） | 230 KB | `2185f9f957f5` |
| `appdata.tgz`（root 直读卷，172 文件） | 674 KB | `4e2b1fb595e0` |
| `workpal-tree.tgz`（源码树，除 .git/.env） | 109 MB | `da9e6ac70289` |
| `caddy-volumes.tgz` | 2.8 KB | `238efd77c0cd` |
| `prod.env`（600，仅主机） | — | 不出主机 |
| `MANIFEST.txt` / `SHA256SUMS` | — | 主机侧 `sha256sum -c` 全部 OK |

Offsite 副本：`rakazo.dump`、`appdata.tgz`、`SHA256SUMS`、`MANIFEST.txt` 已拉回工作机并 `shasum -c` 通过。

**隔离恢复验证**（工作机 colima PostgreSQL 16.15，与生产同版本）：恢复后计数与生产完全一致（`migrations=90 messages=7 user=1 bots=1 threads=1 runs=4 tasks=4 events=49`）；7 条消息内容逐条可读（含中文与 bot 卡片块）；appdata 解包 172 文件。唯一告警：pg_restore 17 客户端对 PG16 服务端发 `SET transaction_timeout` 报错一次，被忽略，属客户端/服务端版本差，无数据影响（主机侧用 16 客户端种子时零错误）。

## 3. 迁移副本演练（本地，2026-10-16）

**实际待应用集合（固定）**：目标提交迁移目录 108 项，生产已应用 90 项，交集之外：

- 待应用 **19 项**（顺序即目录时间戳序）：`20261008000000_background_agent_tasks` → `20261008100000_product_harness_phase1` → `20261012000000_avatar_style_bloub_default` → `20261013000000_task18_event_envelope` → …task18 系列 8 项… → `20261013030000_structured_run_plans` → `20261013040000_semantic_run_steps` → `20261013050000_run_todos` → `20261013060000_run_wait_started_at` → `20261013070000_attempt_fence_uniqueness` → `20261013080000_execution_revocation_outbox` → `20261013090000_background_task_lookup_indexes` → `20261013100000_interventions` → `20261013110000_intervention_presentation` → `20261013120000_execution_history_indexes` → `20261013130000_run_snapshot_rev`。
- **孤儿迁移 1 项**：`20261007050303_avatar_style_bloub_default` 已应用于生产但不在任何现存树中（10-07 部署当日在主机应用，后在仓库重建为 `20261012000000_…`）。两者 SQL 均含 `ALTER TABLE "user" ALTER COLUMN "avatarStyle" SET DEFAULT 'bloub'`，幂等无冲突。

**演练结果**（对已验证恢复副本执行 `prisma migrate deploy`，Prisma 7.10.0）：

- 19 项全部成功，**总耗时 2.4s**，单项 1.5–14.5ms；无锁等待（单连接、闲置库）；切换时迁移步骤所需停机窗口≈0。
- 迁移后 `_prisma_migrations`=**109**；业务计数不变；7 条消息仍可读；`avatarStyle` 默认值=`'bloub'`。
- 幂等重跑：`No pending migrations to apply`。
- **孤儿迁移无害**：`migrate status` = "Database schema is up to date!"（108 项目录全部已应用，多出的 1 行被忽略）。
- **19 项全部为纯增量**：无 DROP TABLE / DROP COLUMN / SET NOT NULL / DELETE。
- **旧代码×新 schema**：旧树（b101d70，89 项目录，prisma 7.10.0）对已迁移库执行 `migrate deploy` → "No pending"，退出 0 → 源码回滚后旧 api 启动命令不会被迁移层卡死；结合纯增量事实，旧 Python 应用大概率可在新 schema 上继续运行（业务级验证不在本演练范围，见 §6 一致性恢复）。

ECS 侧（真实拓扑、生产副本种子库）的迁移应用已在成功演练（§4 Run 1b）中验证：api 容器启动命令执行 `prisma migrate deploy`，种子库 90 → 109，业务计数不变。

## 4. 部署脚本演练（生产 ECS 上的隔离目录）

### 演练拓扑（`dep01-drill` 分支，仅本地，不合并）

- 目录 `/srv/workpal-dr`，Compose project `workpal-dr`（容器/卷/网络全部独立命名）；Caddy 仅发布 `18080:8080`（生产占用 80/443/8080）；健康检查经 SSH 隧道 `127.0.0.1:18080` 从工作机访问。
- 镜像仓库名经 `.env` 覆盖为 `workpal-dr/{app,agent-runtime,computer}:dr` → **绝不重打生产 `:local` tag**。
- 演练 `.env` 全新随机密钥（openssl hex，均 ≥32 字符，无需 `RAKAZO_ALLOW_DEV_SECRETS`）；`RAKAZO_DEPLOY_DIR`/`CADDYFILE_PATH` 指向演练目录；origins 统一为隧道地址。
- 种子：演练 postgres 卷从生产备份 `pg_restore`（90 项迁移、7 条消息），appdata 卷解包生产备份（172 文件）→ 演练栈 = 生产数据副本 + 目标提交代码，与真实切换同构。

### 脚本修复（可评审提交，`codex/dep01-deploy-rehearsal`）

1. `364570e`：快照/回滚路径改为从 `APP_DIR` 推导（默认值与生产旧行为逐字节一致）。修复前：快照与恢复硬编码 `/srv/workpal`，`APP_DIR` 改指他处时回滚会恢复**错误的树**；同时把 ERR trap 提前到快照完成之后，rsync / `compose config` 失败留下的半更新树也会回滚（原脚本这两种失败不回滚）；首次部署（目录不存在）时明确降级为"无回滚目标"并提示。
2. `dda042c`：回滚中的重建失败原先在 `set -e` 下静默退出（演练 run 1 实测踩中）；改为分支处理并打印 ROLLBACK REBUILD FAILED 诊断。

### Run 1（意外失败 → 回滚路径实证，2026-10-16）

daocloud 镜像源对 `maven:3.9.11-eclipse-temurin-21` manifest 瞬时 **502**（主机侧复测：502→401→401，401 为正常 token 握手，即已恢复；docker.io 直连不可达）。Java 构建 FROM 解析失败 → `up -d --build` 非零 → **ERR trap 自动回滚**：恢复 `/srv/workpal-dr-rollback.tar.gz`（新路径逻辑生效，未触碰生产档案）→ 重建再次 502 → 暴露"回滚重建失败静默退出"缺口（→ 修复 `dda042c`）。脚本以 1 退出。种子 DB 未受影响（失败发生在任何应用容器创建前）。

顺带实证：磁盘守卫通过（余 12081MB）、快照/rsync/三层 compose `config --quiet` 全部正常；computer 镜像 apt/uv 层命中 10-07 buildkit 缓存；GitHub release 下载秒级完成（10-07 的卡顿是瞬时的）。

### Run 1b（成功路径，2026-10-16）

镜像源恢复后重跑（drill 分支 `c105ad3` = 目标提交 + 脚本修复 + 演练拓扑）：

- 全流程 **exit 0**，脚本输出 `Deployed c105ad3; http://127.0.0.1:18080/health is healthy.`；总耗时约 **16 分钟**（Java runtime 从零全量构建约 11 分钟：拉取 maven 3.9.11 基础镜像 + `dependency:go-offline` + 打包；app 镜像 pnpm install+build 约 8 分钟，与 Java 并行）。
- 三层 compose 合并、`config --quiet`、GIT_SHA 注入、健康轮询、`.last-deployed-revision` 写入（=`c105ad3`）全部按设计工作。
- 演练栈 7 容器全部健康：postgres（种子库）、**agentscope（Java：openjdk 21.0.12.1 + runtime.jar，健康检查走 RuntimeHealthcheck）**、api、worker、web、supervisor、caddy；computer/data-init 一次性容器 Exited 0。
- **迁移在真实部署路径应用**：api 容器启动命令 `prisma migrate deploy` 把种子库 90 → **109** 项，业务计数不变（messages=7 user=1→2 bots=1 threads=1 runs=4 tasks=4）。
- 冒烟（经隧道）：`/health`={"ok":true}；web 首页 200；**注册成功**（better-auth 写入新用户，origin 校验通过）→ 证明已迁移 schema 上写路径、鉴权、消息持久化基础可用。
- **生产零影响**（期间实测）：生产 `/health` 200、7 个容器 Up 9 days 未重启、三个生产镜像 ID 未变（演练镜像走 `workpal-dr/*:dr` 独立 tag）、messages=7。
- 资源：内存峰值期间 available ≥3.0G（4G swap 兜底未动用）；磁盘由 16G 降至 4.2G（新镜像约 6.5G + 导出暂态）。

### Run 2 / Run 2r（失败路径，2026-10-16）——含两起环境事故

**Run 2**（注入：health.ts 返回 500，提交 `2ba21c5`）：构建阶段 `pnpm install` 失败（corepack 从 registry.npmjs.org 下载 pnpm 超时；当时磁盘已被并行构建挤到 **258M→0，ENOSPC 为根因嫌疑**，网络探测同期正常）。ERR trap 立即回滚：快照恢复成功，回滚重建在容器层解包时 ENOSPC → 走 `dda042c` 新增的诊断路径退出（**ROLLBACK REBUILD FAILED** 信息 + exit 1，实证有效）。**事故处置**：停 builder 容器止血 → 清 dangling 回收 5.1G → 生产 postgres 全程无错误（日志核查零 WAL/panic），公网 `/health` 200。

**Run 2r**（注入：compose api command 崩溃，提交 `1d57dde`；磁盘已恢复 12G）：主构建与回滚重建**都**倒在 corepack→npmjs ETIMEDOUT（主机侧复测 npmjs 3×200，2–5s 波动，确认为间歇性抖动而非封锁）。回滚再次恢复源码树成功并以新诊断路径退出。**关键发现**：run-1b 的 app 镜像 buildkit 缓存链已在 ENOSPC 事故中丢失（回滚重建重跑了 pnpm install 而非缓存命中）。

**事故级发现（影响真实切换）**：

1. **磁盘数学**：40G 盘上 buildkit 缓存与 docker store 双份存储；3.8G 的 app 镜像每次 `up --build` 即使全缓存命中也会重新导出（`sending tarball`，暂态 ingest ~4G）。两套 app 镜像链（部署版+回滚版）+ 缓存 + 暂态 ≈ 14G 峰值 → **真实切换前必须预留 ≥10–12G**，且回滚重建依赖缓存链存活。
2. **`.dockerignore` 不含 `infra/`**：仅改 compose 文件也会失效 app 镜像 COPY 层 → 全量 pnpm 重装重建。drill 分支加 `infra/` 排除（提交 `28ed23f`，演练专用；**建议后续作为独立优化 PR 进主干**——compose YAML 本就不影响镜像内容）。
3. **corepack/npmjs 抖动**是切换日的现实风险：app Dockerfile 无 registry 镜像钩子，`RUN corepack enable` 后每次缓存失效构建都从 npmjs 拉 pnpm。缓解：切换前**预构建镜像**（缓存链+镜像双就位，窗口内只做缓存命中重建）、失败重跑、以及（可选，另行评审）给 Dockerfile 增加 `COREPACK_NPM_REGISTRY` 类 ARG（对齐既有 `DEBIAN_MIRROR` 模式）。

### Run 2rp（compose config 失败 → 半更新树回滚，实证 trap 前移修复）

注入 payload 的 YAML 引号缺陷（`: ` 使 command[2] 解析为 mapping）让 `compose config --quiet` 直接失败——**意外实证了任务书要求检查的场景**：rsync 已把树更新为坏版本、config 失败时，修复后的脚本（trap 自快照起生效）正确恢复快照树并尝试重建；修复前的脚本（trap 在 config 之后才挂）会静默退出并留下半更新树。回滚重建期间暴露第二个问题：buildkit 的 node 基础层 blob 已被缓存 GC 逐出，需经 daocloud 以 ~160KB/s 重下 211MB，叠加全量重建将顶穿 30m 回滚超时 → 主动终止本次运行，改为"预热构建修复缓存链 + 修正注入 payload"后重跑。

### Run 2s（失败注入第二版：暴露演练技巧自身缺陷）

注入 payload 修正为合法 YAML（`3b3c924`）后重跑：`compose config` 通过、主构建完成、up 创建容器——但失败点出乎预料：**supervisor 不健康**（`dependency failed to start: container workpal-dr-supervisor-1 is unhealthy`，日志循环 `No projects matched the filters in "/app"`）。根因是演练技巧自身：`.dockerignore` 排除 `infra/` 把 pnpm workspace 成员 `infra/sandboxes/supervisor`（及 `infra/updater`）从 app 镜像中剥掉了——run 1b 的健康镜像构建于该修改之前，故未暴露。同时回滚重建也未命中预热缓存：磁盘 85% 下 buildkit 在导出暂态挤压中把预热链 GC 掉，重建退化为全量 pnpm install（再遇 npmjs 抖动）+ temurin blob 502 → 第三次走 ROLLBACK REBUILD FAILED 诊断路径退出（该诊断分支已三次实证）。

**修正（`04d1106`/`bbce2aa`，drill-only）**：①`.dockerignore` 收窄为 `infra/compose/`——supervisor/updater 包回到镜像，compose 文件（含注入 payload）仍对构建上下文中立，A/B 两树上下文哈希一致；②移除 agentscope/computer/worker/web/supervisor 的 `build:` 段，bake 只剩 api 一个 app 镜像目标（java/computer 直接用预构建镜像），导出暂态与缓存增量减半以上。修正后先预热构建（api 单目标、无超时压力、npm 重试循环），再跑终版。

### Run 2t（失败注入终版：绿色回滚路径，2026-10-16）——**通过**

实际链路与预期略有出入但语义更强：主构建的缓存链在前一轮磁盘打满事件中受损，`pnpm install` 重跑并于 3.4s 崩溃（node 异常转储；当日 npmjs 间歇抖动的又一表现）→ ERR trap → 快照恢复 A' 树 → **回滚重建从恢复的源码全量重建成功（约 3 分钟，npm 窗口配合）** → api 以健康命令启动、migrate deploy 幂等（109 保持）→ 全栈健康 → 轮询通过 → 输出：

```
Rolling back: restoring snapshot /srv/workpal-dr-rollback.tar.gz.
Rollback complete: production is healthy at the previous revision.
RUN2T EXIT: 1
```

终态核验：7 容器全部 Up/healthy（**supervisor 恢复健康，证实 `.dockerignore` 修复**）；隧道 `/health`={"ok":true}、web 首页 200；远端树=健康命令（注入已随快照恢复消失）；DB 保持迁移后状态（mig=109、messages=7、users=2 含 run 1b 注册）；`.last-deployed-revision` 为空——**演练手工步骤产物**（预热阶段的手工 rsync --delete 删除了该仅存于远端的文件，后续快照因而不含它；正式流程中脚本先快照后 rsync，失败回滚会将其恢复，无生产影响）；磁盘 4.6G 未再触底；生产栈全程无感。

注：run 2s/2t 期间在主机 `/etc/buildkitd-mirror.toml` 追加 `[worker.oci] gckeepstorage = 6000` 并重启 builder（防止导出暂态挤压下缓存链被 GC——run 2s 缓存失效的机制）。该配置对正式切换同样有益，**保留**；注意重启 builder 会使"在用"缓存记录退化为可回收，切换前不要再重启 builder 或 prune 缓存。

### 旧 Python runtime 可重建性测试（生产回滚兜底，2026-10-16）——**通过**

从备份 `workpal-tree.tgz` 解包旧树（b101d70）到隔离目录，用 `mirrorbuilder` 构建 `services/agentscope/Dockerfile`（ghcr uv 基座走 ghcr 镜像源）：构建成功，产出 531MB 镜像（与生产在跑的 `workpal/agentscope:local` 同尺寸）。关键耗时：`uv sync --frozen`（pypi 大陆低速）**1358s ≈ 23 分钟**。含义：

- 真实切换若回滚到旧树，`up --build` 全量重建 = 旧 Python agentscope（~23 分钟）+ 旧 app 镜像（~10 分钟），**可能顶穿脚本默认 30m BUILD_TIMEOUT** → 切换日必须 `BUILD_TIMEOUT=90m`。
- 本测试已把旧树构建链灌入 buildkit 缓存：切换前不 prune 缓存/不重启 builder，则回滚重建缓存命中、分钟级完成。
- 终极兜底：旧 `:local` 镜像全部保留在 daemon，`up -d --no-build` 可跳过重建直接以旧镜像起栈。

### 演练终态与产物处置

- 演练栈已 `compose stop` 冻结；`workpal-dr/*` 镜像（app 3.75G / agent-runtime 584M / computer 2.05G）、`workpal-oldtest/agentscope:drill`（531M）、演练卷（终态为**恢复演示后的 90 态 DB** + 重解包的 appdata）、A' 树、`/srv/workpal-dr-rollback.tar.gz` 快照，全部保留至验收。
- **切换前清理步骤（runbook）**：删除 `workpal-dr/*` 与 `workpal-oldtest/*` 镜像（约 +6.9G；drill app 缓存链因上下文含 drill-only 修改对正式树不可复用，java/computer 链可复用）→ 磁盘余量目标 ≥10–12G。
- 主机遗留（有意保留，验收后决定去留）：4G swapfile（未入 fstab；切换日构建峰值保护，演练期间零动用）；`buildkitd-mirror.toml` 追加的 `[worker.oci] gckeepstorage=6000`（原文件备份为 `.bak-dep01`）；`/var/backups/rakazo/20261016T042900Z` 全套备份。
- 生产终态复核：7 容器 Up 9+ days 未重启、公网 `/health` 200、`mig=90` 不变、postgres 日志 3 小时窗口零错误（覆盖两次演练磁盘打满事件）。

## 5. DB+文件一致性恢复步骤（runbook，源码回滚不够时用）

适用：新迁移已应用但必须整体回到部署前状态（旧代码在新 schema 上出现业务级不兼容，或数据被新代码写入后需要作废）。

1. 停写入方：`docker compose … stop api worker supervisor`（保留 postgres、caddy 运行）。
2. 恢复 DB：`docker exec -i <postgres> pg_restore --clean --if-exists --no-owner -U rakazo -d rakazo < 备份/rakazo.dump`（或 dropdb/createdb 后恢复）。
3. 恢复文件：清空 appdata 卷目录后解包 `appdata.tgz`（root，`--numeric-owner` 归档）。
4. 源码树：脚本回滚已从快照恢复；否则手工 `tar -xzf <snapshot> -C /srv`。
5. 重启：`up -d --no-build`（旧镜像仍在 daemon 时优先，避免重建）或 `up -d --build --pull never`。
6. 核对：计数=备份清单基准（`messages=7 …`）、`_prisma_migrations`=90、`/health` 200、登录可用。

演练实证（2026-10-16，在演练栈按上述步骤执行）：恢复前 mig=109、users=2（含演练注册用户）、appdata 172+ 文件；停 api/worker/supervisor → `DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE` + `pg_restore`（exit 0）→ appdata 清空重解包 → agentstate（演练期由 Java runtime 新建）清空 → 核验：**mig=90、messages=7（seq 0–6 role 序列完整可读）、users=1（演练注册被回收）、bots=1、runs=4、events=49、appdata 恰为 172 文件**；源码树=回滚快照的健康状态。DB 与文件一致地回到备份时间点。

## 6. 上线方案（待批准）

- **目标提交**：`8d263ad`（或执行日重新固定的更新 main；固定后工作树必须干净）。
- **前置检查**（窗口开始前）：镜像源可达性（对 `maven:3.9.11-eclipse-temurin-21`、`node:22-bookworm`、`debian:bookworm-slim` manifest 探测非 5xx；npmjs 的 pnpm tarball 探测）；**磁盘 ≥10–12G**（演练实证：40G 盘、双份存储 + 导出暂态；执行上文"切换前清理步骤"）；**不 prune buildkit 缓存、不重启 builder**（回滚速度与旧树重建兜底都依赖在位缓存）；swap 在位；备份当日重跑且校验通过。
- **预构建**（窗口前，不计入停机）：对目标提交先手动 `compose build` 一次（npm 抖动时重试；缓存链 + 镜像双就位），窗口内脚本构建全部缓存命中 → 停机时间从 ~16 分钟压缩到 ~5 分钟，并消除窗口内网络风险。注意：预构建产物在窗口内不可 prune。
- **维护窗口预估**：15–30 分钟（预构建后：脚本缓存重建 ~5 分钟 + 迁移 ≈3s + 健康与冒烟 10 分钟；回滚预留 15 分钟）。生产闲置 9 天，窗口选择无业务压力。
- **执行顺序**：备份（新快照）→ `deploy-workpal.sh`（ECS_HOST/SSH_KEY/HEALTH_URL=生产地址，APP_DIR=/srv/workpal，**BUILD_TIMEOUT=90m，MIN_FREE_MB=8192**）→ 健康 → 冒烟（登录、建 Bot、单次受控 Run、消息持久化、授权拒绝、无重复投递）→ 写 `.last-deployed-revision`（脚本自动）。
- **成功判据**：运行镜像 GIT_SHA=目标提交；agentscope 为 Java（健康检查走 runtime.jar）；API/Worker 分进程健康；`_prisma_migrations`=109 且 0 失败；冒烟全过；7 条历史消息可读。
- **止损**：健康轮询失败脚本自动回滚；回滚后仍不健康 → 手动执行 §5 一致性恢复（备份当日新鲜）；任何数据核对不符 → §5。
- **残余风险**：①旧 Python runtime 重建依赖旧树 + pypi 低速（~23 分钟实测）——缓解：旧树构建缓存已预热且切换前不清理、旧 `:local` 镜像保留（`up -d --no-build` 兜底）、BUILD_TIMEOUT=90m；②镜像源/npm 抖动（run 1/2/2r/2t 四次实证）——前置检查 + 预构建 + 失败重跑，可选后续评审给 app Dockerfile 增加 corepack/npm registry 镜像 ARG（对齐 DEBIAN_MIRROR 模式）；③单主机资源竞争——切换前演练产物已清理、swap 在位；④孤儿迁移——已证无害；⑤`.dockerignore` 未排除 `infra/`导致 compose-only 变更也全量重建 app 镜像——建议作为独立优化 PR（非切换阻塞项）。

## 7. 实际部署后补录

<!-- 时间、部署提交、生产健康与业务冒烟、已应用迁移、观察结论；异常必须写明是否恢复了 DB 与文件的一致状态 -->
