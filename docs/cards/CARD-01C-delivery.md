# CARD-01C delivery record

状态：`in-review`（PR #145 未合并）

- PR：https://github.com/huiliuxu780/WorkPal/pull/145
- 分支：`codex/card-display-content`
- Base：`dc9be3811d1d89129e98521bb57fe27d11f95c69`（main，PR #144 合并后）
- 实现 head：以分支顶端为准（本文件随实现提交）

## 交付内容

### 九个 DisplayBlock 的真实数据路径

服务端 `packages/db/src/card-interactions.ts` 从已持久化的 message blocks / voice groups 投影：

| 类型 | 真实来源 |
| --- | --- |
| markdown | bot `text` block |
| table | chart `data` 的 columns/rows（作为图表详情的数据表替代；不是 Markdown 增强） |
| chart | `chart` block 的 `spec`/`data` |
| collection | legacy `card` KV `lines` 的只读兼容 |
| media | `image` block / 非 HTML、非文档 `file` block |
| html | `file` block 且 mime 为 `text/html` |
| task_status | `subagent` / `cloud_agent` block 的工作投影 |
| page | `file` block 且 mime 为 `text/markdown` / `application/pdf`，打开现有 artifact 文档路由 |
| voice | `voice_call` group 的真实 transcript + duration；音频未持久化时不伪造播放 |

- `CardMessageFact` 增加 `role/callId`，voice group 使用生产 `groupVoiceChats` / `speechFromBlocks` / `voiceChatDuration`。
- HTML/文档/媒体仍引用真实 artifact；collection 不新增 producer，只读旧 `card` KV。
- 总 gate 仍为 `cards_unified_v2`，生产默认关闭；gate 关闭时旧 API/页面路径不变。

### Web 展示注册表与详情

- 新增 `apps/web/src/components/ai/display/DisplayBlockView.tsx`：九类 renderer + `DisplayBlockList` + message 分组。
- 长 Markdown 以渲染高度折叠，详情打开完整正文；table 复用 `@rakazo/chat-ui` 的排序/分页/展开能力；chart 详情包含真实数据表；media 复用图片灯箱与文件预览；HTML 复用 `SandboxedHtmlViewer`；page 打开现有 artifact 路由；task_status 只读；voice 展示 transcript/duration 并对缺失音频明示。
- `Shell` / `MessageView` 在 gate 开启时按 message id 替换对应 legacy block；短文本仍为气泡；chart companion table 不重复渲染；voice group 使用服务端 voice block。
- Execution detail 读取 `ExecutionSnapshot.displayBlocks`，同样通过注册表渲染。
- CI selector 将 display 组件、message-cards、artifact/html/voice 组件和 `packages/chat-ui` table 适配映射到 `card-display-content.spec.ts`；Shell/execution 变化同时选择 CARD-01B 与 display spec。

### 测试与截图

- 单元：`DisplayBlockView.test.tsx` 覆盖九类、HTML sandbox、chart companion、无伪造音频；`packages/db/src/card-interactions.test.ts` 覆盖 html/page/voice/table/collection 投影。
- Postgres：card projection 套件在独立库运行。
- E2E：`card-display-content.spec.ts` 通过真实 RPC artifact + 生产 message block 投影渲染九类，并覆盖 chart 详情、HTML sandbox、390/375/dark；与 CARD-01B/pair 两个 spec 同批回归 6/6。
- 实际截图与原型对照见 [CARD-01C visual evidence](./CARD-01C-visual-evidence.md)。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 0 errors（仓库既有 warnings/infos） |
| `pnpm check` | 18/18 |
| `pnpm --filter @rakazo/web test` | 99 files / 785 tests |
| `pnpm test:unit` | 458 files / 5521 passed / 2 skipped |
| `pnpm --filter @rakazo/web build` | 通过 |
| `pnpm test:postgres` | 49/49 files、433 tests（独立 `workpal_e2e_*` 库） |
| `pnpm test:ci-select` | 100 tests |
| `git diff --check` | 通过 |
| Page E2E | `card-display-content` 1/1；与 CARD-01B/pair 合计 6/6 |

## 已知缺口（未假装实现）

1. 没有独立 table/collection/page producer：table 来自 chart data，collection 来自 legacy card KV，page 来自 markdown/PDF artifact；不新增模型工具或实体。
2. voice 没有音频 artifact；只展示真实 transcript/duration，播放控件明确不可用。
3. displayBlocks 只在当前 snapshot 消息窗口和 Execution result 投影；更早分页消息继续走 legacy 展示路径，未在本任务扩展分页投影。
4. 生产 gate 保持默认关闭；本 PR 未开启任何环境 gate。
