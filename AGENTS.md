# AGENTS.md

- 先检查问题有没有错误前提、逻辑跳跃和信息缺失；区分事实、预测和观点，并指出风险、成本和替代解释。
- 这是独立的 Web-only 项目。不要新增 Electron 或移动端实现，也不要重新设计已复制的前端。
- 应用后端负责鉴权、授权、Bot、长期 Thread、消息、Task/Run、文件、资源权限、并发和审计。模型不得自行扩大凭据或资源权限。
- AgentScope 是唯一生产 Agent 执行器。`scripted` 仅用于确定性测试；禁止把 Pi 恢复为生产回退。
- 完整聊天记录属于 PostgreSQL；AgentScope 工作上下文和压缩状态单独持久化。Task/Run 是执行记录，不是用户管理的新会话。
- 兼容现有前端契约。确需调整时集中在前端 API 层或后端适配器，不在页面中散落协议分支。
- 未实现能力必须失败或禁用，不得用模拟结果冒充真实执行。
- 不提交 `.env`、密钥、真实用户数据、私有 URL 或本机身份信息。提交前检查 `git status` 和 diff。
- UI 继续使用 `@rakazo/ui-tokens`、`@rakazo/ui-web`、`@rakazo/chat-ui` 和 `apps/web/src/components/ai/`，保持现有视觉语言。
- Python 服务使用 `uv` 和 `services/agentscope/pyproject.toml`；TypeScript 使用仓库锁定的 pnpm。修改后至少运行受影响包的类型检查和定向测试。
