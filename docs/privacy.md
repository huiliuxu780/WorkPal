# MyPal data handling / 数据处理说明

MyPal is self-hosted. The deployment owner controls the server, access, backups and retention. This document describes the implementation; it does not promise a separate hosted service or a fixed retention period.

MyPal 为自托管产品。部署者管理服务器、访问权限、备份和保留期限。本说明描述产品实现，不代表另有托管服务或固定的数据保留承诺。

- Accounts, full chat records, files and execution records are stored by your deployment. Model credentials are encrypted by the application backend.
- Messages, relevant history, instructions, attachments and approved tool results may be sent to the model provider selected in your settings. Connected services receive the data needed for authorized actions. Voice and external memory providers receive data only when those features are configured and used.
- AgentScope working context is stored separately from the full transcript. Deleting server files or backups and managing provider-side retention are the deployment owner's responsibility.

- 账号、完整聊天、文件和执行记录由你的部署保存；模型凭据由应用后端加密保存。
- 消息、相关历史、指令、附件及获准工具结果可能发送给设置中选择的模型提供方；已连接服务接收执行获准操作所需的数据。语音和外部记忆服务仅在配置并使用相应功能时接收数据。
- AgentScope 工作上下文与完整聊天记录分开保存。服务器文件、备份以及外部提供方的数据保留由部署者管理。

For questions about a particular deployment, contact its owner. Product feedback: [GitHub Issues](https://github.com/huiliuxu780/WorkPal/issues).

具体部署的数据问题请联系部署者。产品反馈：[GitHub Issues](https://github.com/huiliuxu780/WorkPal/issues)。

[broken](./ci01-does-not-exist.md)
