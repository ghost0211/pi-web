# 本轮运行耗时

## 语义

- 一轮是 Pi SDK 的一次 logical run，不是单次模型请求、单次工具调用或会话存活时间。
- RPC 普通 prompt 在调用 SDK 前打点，包含该提交的 preflight/自动压缩；独立扩展或子代理运行在首个 `agent_start` 打点。
- 工具执行、重试、配额备用模型切换、自动压缩及同一运行内的排队/续跑都保留同一起点。
- `agent_end` 不结算。`agent_settled`（成功、错误或 Stop）结算一次；没有 settled 的旧 SDK 仅在对应 prompt 完成且不再 streaming 时兜底。
- 新的扩展运行拥有新 runId；旧 prompt 的迟到完成不能结算新运行。

## 服务端与持久化

`lib/run-timing-runtime.ts` 用 `performance.now()` 测量完成耗时，epoch `startedAt` 用于实时列表。完成后由 `SessionManager.appendCustomEntry()` 追加：

```json
{"customType":"pi-web:run-timing","data":{"version":1,"runId":"uuid","startedAt":1770000000000,"finishedAt":1770000005000,"durationMs":5000,"finalAssistantEntryId":"entry-id","aborted":false}}
```

只绑定开始时 leaf 边界之后、当前分支实际生成的最后一个 assistant。拒绝的 preflight、无 assistant 的命令/提前取消不产生假记录；开始边界不在当前分支时不跨分支猜测。写计时元数据失败会记录日志，但不阻断原有 SDK 事件、任务或通知。销毁后的迟到事件不再写入。

这是一条不可见 `custom` entry，不是 `custom_message`，不影响消息/工具数量，也不参与模型上下文。

- `get_state` 增加 `runStartedAt: number | null`。
- `GET /api/agent/running` 增加 `runningSessionStartedAt: Record<string, number>`。
- 页面刷新使用同一服务端起点，不以首次轮询/会话创建/最近活动时间作为起点。缺少可用起点时不伪造实时耗时。
- 运行起点仅在活跃 wrapper 内存中保留；进程被杀后不会把中断的运行当作仍在继续。重开后的历史显示可使用下述估算。

## UI 投影

`lib/run-duration.ts` 用 assistant entry ID 建索引，`session-reader` 只对返回的 UI assistant 副本增加 `runDurationMs`/`runDurationEstimated`。原始 SDK entries 不改变。按具体 assistant ID 读取完整文件中的记录，确保分页边界、分支和压缩后的历史仍显示该回答的原始耗时。

旧记录没有精确起止时，利用用户提示/报告 entry 的追加时间与该段最后 assistant entry 的追加时间估算，并显式显示“本轮耗时约”。不能使用 assistant message 的内层 timestamp 作为结束时间：它通常是模型请求开始时间。压缩不重置提示起点，晚到的子代理报告开启独立估算段，用户间闲置时间不计入。

完成后“处理详情”摘要显示耗时；没有过程消息的简单回答也显示耗时，但不增加空的折叠按钮。精确完成记录也分隔没有新用户提示的独立 SDK 运行，避免把已完成答案藏进后一次运行的过程详情。

`RunningTasksPanel` 使用一个 `useLiveClock`，每秒重绘列表内计时，不令整个 AppShell 每秒重绘，也不为每一行建立计时器。可见性恢复时立即补齐时间；面板关闭/无计时数据时清理 interval。实时数值不通过 aria-live 每秒播报。

## 回归验证

- `lib/run-timing-runtime.test.mjs`：单调钟、反向校时、叶子/分支边界、重复 start、无输出、停止、持久化失败、销毁。
- `lib/rpc-manager-run-timing.test.mjs`：wrapper/API 起点、queued/retry、两轮、扩展新运行、异常和旧 SDK 兜底。
- `lib/run-timing-sdk.integration.test.mjs`：真实 SDK + 无网络假模型 + 延迟工具，结算/文件重开与模型上下文隔离。
- `lib/run-duration.test.mjs`：历史估算、压缩、分支/分页、原始 entries 不变。
- `components/ProcessDetailsGroup.test.mjs`、`components/RunningTasksPanel.test.mjs`、`hooks/useLiveClock.test.mjs`：摘要/实时显示、时钟、重开、清理与缺失数据。
