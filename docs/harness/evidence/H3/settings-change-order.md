# H3-06：GitHub 设置变更单（待授权，未执行）

单元：H3。编制日期：2026-10-28。**本文件只是变更单。截至编制时刻没有对仓库设置做任何修改。**

依据：[AGENTS.md](../../../../AGENTS.md) 任务交付与审核铁律第 7 条（修改 GitHub 设置需负责人明确授权）、[HARNESS-01 H3 步骤 10](../../../tasks/HARNESS-01.md)、H3 任务书 `docs/tasks/first-batch-20261027/H3.md` 的 H3-06（派发输入，尚未纳入 git）。

## 1. 当前值（实测查询证据）

查询时间与命令：

```bash
gh api repos/{owner}/{repo}/branches/main/protection   # → HTTP 404
gh api repos/{owner}/{repo}/rulesets                   # → []
gh api repos/{owner}/{repo}/rules/branches/main        # → []
```

脱敏后的原始响应：[settings/settings-before.json](./settings/settings-before.json)。

| 项 | 当前值 |
| --- | --- |
| `main` branch protection | 未配置（HTTP 404 `Branch not protected`） |
| rulesets | 空数组 |
| `main` 生效规则 | 空数组 |
| required status checks | 无 |
| force push | 未被禁止（`main` 上技术上可 force push） |
| 分支删除 | 未被禁止 |
| merge queue | 未启用 |

**后果：** 红色 `CI result` 目前不阻止合并；`CI result` 只是信息性检查。这与 HARNESS-01 交付结果第 5 条不符。

## 2. 目标值

推荐用 classic branch protection（语义与需求 1:1，回滚是单次 DELETE）：

```bash
gh api -X PUT repos/{owner}/{repo}/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["CI result"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "required_merge_queue": null
}
JSON
```

逐项对应需求：

| 目标 | 字段 | 说明 |
| --- | --- | --- |
| 要求当前 head 的 `CI result` | `required_status_checks.contexts = ["CI result"]` | 只列这一个固定名称。不要把 `web`/`backend`/`agentscope` 等选择性 job 列为 required——它们在 docs-only PR 上会被合理跳过，列进去会让 PR 永久 pending |
| 不要求每次手动同步 main | `strict: false` | `strict: true` 会强制"合并前分支必须是最新"，明确要求不开 |
| 禁止 force push | `allow_force_pushes: false` | 与 AGENTS.md"不 force-push"一致 |
| 禁止删除 main | `allow_deletions: false` | |
| 不开 merge queue | `required_merge_queue: null`、`required_linear_history: false` | 只有出现并发合并证据时才另议 |
| 不引入评审人数门槛 | `required_pull_request_reviews: null` | 本次未授权改变评审要求；审核仍按 AGENTS.md 由负责人或独立审核者执行 |

### 需要负责人裁决的一项：`enforce_admins`

- **`true`（推荐）**：管理员也受 `CI result` 约束，门禁才真的"阻止合并"。代价：紧急合并必须先临时解除保护（即下面的回滚动作），这会留下一条可审计的设置变更记录。
- `false`：管理员可绕过红色检查直接合并。门禁对唯一维护者形同虚设，但紧急路径更顺。

变更单默认按 `true` 编制；若选 `false`，请在批准时明确写出，并说明绕过时的记录方式。

### 备选方案：ruleset

如果更希望用 rulesets（可显式声明 `bypass_actors`、可分层、可临时 `disabled`）：

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_status_checks",
      "parameters": { "strict_status_check_enabled": false,
                      "required_status_checks": [{ "context": "CI result" }] } }
  ],
  "bypass_actors": []
}
JSON
```

取舍：rulesets 的 `bypass_actors: []` 表示无人旁路（等价于 `enforce_admins: true`），且可以只把该 ruleset 置为 `disabled` 而不完全删除；但仓库会同时存在两套保护机制的心智负担，且当前没有任何 ruleset 历史可参照。**二选一，不要同时启用。**

## 3. 影响范围

- 所有以 `main` 为 base 的 PR：合并前必须有该 head 的 `CI result` 成功。
- 当前 7 个 open PR 会受影响：#147（head `d15cc7e`，`CI result` 已 success）、#136、#100、#48（draft）、#44（draft）、#8、#1。其中 #1、#8、#44、#48 的 head 可能没有近期 run；启用后它们需要重新触发 CI 才能合并。draft PR 的 `ready_for_review` 会触发一次选择性 run，属于既有行为。
- `main` push 后的 CI 运行不变；设置不影响触发方式。**本变更单不修改任何 CI 触发方式**（`ci.yml` 的 `on:` 保持原样）。
- 本次 H3 在 `select-checks` job 里新增了仓库卫生检查步骤，会让 `select-checks` 失败时 `CI result` 一并失败（选择器失败不算通过，这是既有语义）。启用保护后，卫生违规将直接阻止合并——这是预期效果。
- 不影响部署（本仓库无生产部署流程变更）、不影响他人分支的推送权限（只限制 force push 与删除 `main`）。

## 4. 回滚方法

```bash
# classic protection：一次调用回到当前 404 状态
gh api -X DELETE repos/{owner}/{repo}/branches/main/protection

# ruleset 方案：先停用，确认无副作用后再删除
gh api -X PUT repos/{owner}/{repo}/rulesets/{id} -f enforcement=disabled
gh api -X DELETE repos/{owner}/{repo}/rulesets/{id}
```

回滚后必须重新执行第 1 节的三条查询，确认恢复到 `404 / [] / []`，并把输出追加到本目录的 `settings-after-rollback.json`。

## 5. 验证方法（获批执行后）

1. 读取设置并保存脱敏响应到 `settings/settings-after.json`，逐项核对第 2 节表格。
2. 受控失败验证：在一个临时分支上制造一个已选 job 失败（例如改坏一个 docs 相对链接，让 `docs` job 红），开一个验证 PR，确认：
   - `CI result` 为 failure；
   - PR 页面显示"required check failed"，合并按钮不可用；
   - `gh api -X PUT repos/{owner}/{repo}/pulls/{n}/merge` 返回 405 且消息指明缺少必需检查。
3. 受控 force-push 验证：不对 `main` 真的执行 force push。用 `git push --dry-run --force` 到 `main` 验证被拒绝，或直接读取保护设置里的 `allow_force_pushes: false` 作为证据；**禁止**用真实 force push 试探。
4. 关闭并删除验证分支（删除分支本身也需要授权，见 AGENTS.md 第 7 条）。
5. 把 run URL、API 响应、验证 PR 编号写入本目录，并在 [HARNESS-01](../../../tasks/HARNESS-01.md) 与 H3 证据索引里把 H3-06 从"待授权"改为已执行。

**创建验证 PR、删除验证分支、以及执行上述任何 `gh api` 写操作，都需要负责人在执行前的明确批准。本文件不构成批准。**

## 6. 当前状态

| 项 | 状态 |
| --- | --- |
| 当前值查询证据 | 已完成（`settings/settings-before.json`） |
| 目标值、旁路主体、影响范围、回滚、验证方法 | 已编制（本文件） |
| 设置变更执行 | **待授权，未执行** |
| H3-06 判定 | **不算通过**。按 H3 任务书，外部设置未获授权时仓库内变更可独立进入审核，但 H3 整体不得记为 `done` |
