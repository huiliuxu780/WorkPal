# CARD-01 卡片统一 v2 已批准原型

状态：产品负责人已于 2026-10-24 批准此原型。批准只确认设计与交互基线，不授权直接修改生产页面，也不表示目标协议已经作为生产 API 存在。

规范来源：[CARD-01 卡片统一决策](../../CARD-01-decision.md)。

## 入口

- 总索引：`mockup/cards-hifi-v4/index.html`
- 27 个产品场景：`mockup/cards-hifi-v4/cards.html`
- 8 个详情场景：`mockup/cards-hifi-v4/a-detail.html`
- 提醒场景：`mockup/cards-hifi-v4/b-alerts.html`
- 状态场景：`mockup/cards-hifi-v4/c-states.html`
- 目标协议与兼容映射：`card-unification.html`
- PRD：`card-requirements.md`
- 统一说明：`card-unification.md`
- 视觉规范：`mockup/cards-hifi-v4/STYLE-SPEC.md`

页面是本地确定性演示，不连接真实后端，也不代表付款、发送、安装或授权成功。

## 目录

```text
card-unification-v2/
├── card-requirements.md
├── card-unification.md
├── card-unification.html
├── card-unification.png
└── mockup/cards-hifi-v4/
    ├── index.html
    ├── cards.html
    ├── a-detail.html
    ├── b-alerts.html
    ├── c-states.html
    ├── style.css
    ├── gen.py
    ├── architecture.py
    ├── shot.py
    ├── verify.py
    ├── STYLE-SPEC.md
    ├── 关键截图 shot-*.png / overview.png
    └── 原型静态资源 *.svg
```

旧版基线图和旧/新并排对比图保留在评审记录中，不属于运行源。缺少 `old/` 时 `shot.py` 会跳过对比图生成，不影响页面、验收图和 overview。

## 重新生成与验收

需要 Python 3、Pillow、Playwright，以及可用的 Chrome/Chromium。

```bash
cd docs/cards/source/card-unification-v2/mockup/cards-hifi-v4
python3 gen.py
python3 architecture.py
python3 verify.py
python3 shot.py
```

`verify.py` 使用真实浏览器检查导航、七条核心路径、A8 只读 playbook 详情、A10 revision/fingerprint、A12 两步付款、B3 安装与授权、attention queue、只读重新加载、A13 独立计划审阅、A7/A8 严格审批变体、390/375px、深色状态和文档语义映射。

本次入库验收：

- 真实 Chromium 155.0.8059.85：15/15 通过（本轮新增 A8 只读 playbook 检查）。
- 390px 与 375px 的五个页面均无文档横向溢出；A13 卡宽分别为 310px 和 295px。
- `gen.py` 与 `architecture.py` 重跑前后，Python 源文件和生成 HTML 的 SHA-256 一致。
- 从入库源重新生成关键截图后，连续两次截图运行的哈希一致。
- `verify.py` 的 A13 断言要求独立 `PlanReviewView`/`plan_review`，并拒绝 `requestApproval(tool)` 归类。
- A8 使用 `requestApproval(skill_save)`，权威是 TaughtSkill 保存；新增只读 playbook 详情，无编辑、测试、执行、保存或批准按钮，关闭后焦点回到“查看 playbook”。A7 的 `app_connect` 与 `mcp_approval` 分别使用 `connect.app_authorization` 和 `connect.mcp_assignment`，断言拒绝通用审批归类。
- A8 playbook 详情桌面与 390px 证据为 `shot-a8.png` 与 `shot-a8-390.png`。
- A7 含真实 MCP assignment 风险卡，展示 `allowAllTools: true`、服务器范围、风险层级和“允许全部工具”操作；390/375 证据为 `shot-a7-390.png` 与 `shot-a7-375.png`。

A8 playbook 增量为本任务新增，截图与校验已生成，等待产品负责人确认；确认前不开始生产页面开发。

已知非阻断项：上一轮接手人的完整变异日志未随交付保存；评审侧此前已用独立定向变异证明旧断言能捕获回退。本轮新增 A8 检查通过真实浏览器与负向选择器验证，未单独做变异测试。本轮未声称完整 WCAG 合规。

## 安全与视觉边界

- 只使用示例地址、脱敏卡号和演示数据；不含密钥、真实用户数据、私有 URL 或本机绝对路径。
- 失败、过期和结果未知状态不提供重试；读取失败只提供“重新加载”。
- 终态正文保持可读，不以整卡 40% opacity 表达状态。
- 原型 sand 色值不是生产 token。实现必须按 `STYLE-SPEC.md` 映射到 `@rakazo/ui-tokens`、`@rakazo/ui-web`、`@rakazo/chat-ui` 和 `apps/web/src/components/ai/`。

## 完整性校验

在本目录运行：

```bash
shasum -a 256 -c SHA256SUMS
```
