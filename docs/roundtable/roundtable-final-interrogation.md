# 圆桌模式最终对抗审查

状态：通过  
日期：2026-10-22

## 审查范围

- `roundtable-product-requirements.md`
- `roundtable-architecture.md`
- `roundtable-implementation-plan.md`
- `verify-implementation-plan.mjs`
- `verify-implementation-plan.test.mjs`
- 与结论直接相关的 Runtime、executor 和数据库代码证据

## 审查方法

按照已安装 pstack 的 `interrogate` reviewer prompt、rubric 和 code-quality lens，由两名只读 reviewer 独立检查，再由主审判断 finding 是否成立。最终审查只使用用户允许的模型：

- Reviewer A：`gpt-6.1-sol`
- Reviewer B：`gpt-5.6-sol`

reviewer 不修改文件。每轮成立的 finding 先退出审查阶段，再单独修订文档和验证器，然后由同一组 reviewer 复查。

## 终审中关闭的缺口

1. `background_continuation` 获得按 Run/Attempt 隔离的 Runtime scope，不占普通 chat admission；只有动作分支可获得批准后的精确工具与参数。
2. 阻塞请求改为 `action | input` 判别联合。用户补充信息不再伪装成工具审批，答案按 request identity 幂等消费。
3. chat admission 改为带 expiry、heartbeat 和单调 fence 的持久 lease；stale owner 由 reconciler 回收。
4. 等待审批或输入前，Runtime pending state 按 Run/Attempt 从共享 chat state 原子 snapshot-and-detach；下一条普通 prompt 不能误答或批准旧请求。
5. 每次 Runtime 调用（包括 resume）前都预持久化新的 execution fence 和 suspension key。Runtime pending state 从创建起携带身份。
6. owner 过期时先进入 recovering；只有 Runtime 对旧 fence 给出 `clean | detached` 证明后才能释放并唤醒下一 Run。
7. RT-25 负责 F04；RT-26 负责 C06、P05、F04。验证器固定检查这一归属拆分，避免 fencing、排队、恢复与压缩安全的关键场景重新漂移成“无人负责”。

## 最终结论

两名 reviewer 在最后一轮均返回 `No findings`。计划当前包含：

- 31 个按拓扑顺序排列、可独立合入的开发任务；其中原 session/admission 大任务拆成 lease、Runtime checkpoint 和 steering 三个并行单元；
- 39 条验收标准的实施归属和集成验证；
- 96 个原子场景的实施归属和集成验证；
- 11 个计划验证器测试，覆盖缺失 owner、重复任务、未知 ID、未知依赖、环、验证任务假覆盖、依赖闭包和关键 session recovery 归属。

这表示文档和拆分已经达到可以开始实现的状态，不表示生产能力已经实现或 feature gate 可以开启。生产 gate 仍需按 RT-00 至 RT-30 的依赖关系逐项满足；任务编号不是串行排期。
