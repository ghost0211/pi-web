# 上游优先补丁手工移植记录（2026-10-09）

基线：本地 `adbd3ec`（v0.9.49），上游 `c9e1513`（v0.11.0）。本次按本地架构移植逻辑，不合并上游主线，不导入其版本提交。

保留桌面/Tauri、Basic Auth 与 desktop-health nonce 豁免、MCP、内建 subagents、归档只读、会话删除屏障、quota fallback 和 SSE/run-id 对账设计。

## 已适配

| 范围 | 上游参考 | 本地适配 |
| --- | --- | --- |
| 配置安全 | `499aa4f` | 不可读 models.json 抛明确错误；GET 422、PUT 409；禁止空草稿覆盖；初次加载期间及加载失败后均禁用保存。兼容 BOM、行注释和末尾逗号。 |
| 文件授权 | `b3c7255` | 不再从 system、context_edit、codemode-store 或非 coding 工具结果正文授权文件路径；保留本地 coding/subagent 工具、完整输出落盘路径及实际嵌套 coding 调用参数。 |
| Windows 文件路径 | `0c525c8`、`c04bab7`、`fce666a` | 恢复盘符根；编码并保留 UNC 根；插件 relativePath 统一为正斜杠。 |
| CLI 调用 | `afd2575` | 抽取 npm/npx Node CLI 查找机制，保持无 shell 调用；本地无上游 plugin-updates 模块，不导入该模块。 |
| 认证与命令环境 | `47a0bb2`、`6ad18cd`、`beb32a9` | 手动 OAuth 握手改用 randomUUID；子命令过滤 PI_WEB_PASSWORD；Basic Auth 失败共享指数退避，并返回 Retry-After。成功请求不重置猜测计数，桌面健康检测豁免保持原状。 |
| Stop 与上传 | `f5e768e`、`31f0505` | Stop/timeout 后残留进程占住 stdout 时，有界结束工具等待；代理上传缓冲设为 128 MB，兼容现有 100 MB 上传上限。 |
| PWA 网络等待 | `b4a4539` | 导航/资源响应头等待上限 8 秒，失败回退离线页/缓存；不截断已收到响应头的流式正文。 |
| SSE | `1f79174`、`6b0c6a5`、后续 `a84093e` | 进程退出关闭活跃 SSE；慢客户端丢弃可重建增量，积压超限断开并重取快照；订阅者错误隔离。Node 信号注册放入独立 instrumentation-node，避免进入 Edge 图。 |
| 生命周期 | `aed0f3c`、`34c8fdf`、`9ede521` | closing wrapper 不再接收新命令；扩展绑定和 shutdown 共用有限清理期限；SDK dispose 后才正常重开，并发重开共用锁；旧 HMR 回调不能删除新 wrapper。closing 期间继续保护会话删除。即使关闭 idle 回收，Stop 仍有挂起运行兜底期限。 |
| 模型协议与 scope | `7aaeff9`、`f607816` | 不因打开 provider 编辑器强制写入 openai-completions；已有有效匹配时抑制过时 glob 警告，但保留完全失配、精确名称及畸形配置警告。 |
| 历史窗口 | `50a2fd4`、`69882b9` | tail 按可见消息计数，并设原始条目上限；保留可见 custom/subagent/bash/摘要卡；分页头部缺少 user anchor 的轮次也能收拢过程详情。 |
| 聊天终态 | `9182fdf`、`c844973`、`342fc9a`、`0bae9b6` | assistant message_end 刷新用量；显示输出上限截断；无回答截断提供压缩而非直接重试，只读会话无变更按钮；回答出现后折叠过程组，过程副本不重复显示终态提示。 |
| 删除竞态 | `a096af3` | 删除完成时检查最新选中会话，避免用户已切走后被强制跳到空会话。 |
| 依赖/CI | `1e294b0`、`effa464` | Next/eslint-config-next 升至 16.3.8，应用兼容的非强制 audit 修复；SDK 保持 1.1.0；Web/桌面 CI Node 固定 22.19.0。 |

## 手动压缩后用量刷新

修复两个相互叠加的问题：

1. SDK 1.1 在压缩后、尚无新 assistant usage 时返回 `tokens: null`。旧 fallback 会复用保留 assistant 的压缩前 usage。现在明确走压缩后活动上下文估算，包含原生 system/checkpoint、compactionSummary/branchSummary 和 context-visible bash。
2. SDK 的上下文投影把摘要放在保留消息之前，不能仅凭数组位置判定 usage 已发生在压缩之后。现在结合摘要和消息时间戳排除旧 usage。

手动/自动压缩成功后立即刷新；使用递增请求序号，拒绝压缩前延迟 poll 及旧文件估算覆盖新 SDK 结果。不需要发送下一轮对话。新模型响应产生真实 usage 后继续优先使用真实值。

覆盖真实 SDK SessionManager 压缩投影、手动 compact 回调以及乱序 usage 响应回归测试。

## 保留/不直接套用

- `6a1246e` 不移植：与本地明确的新会话显式模型选择持久化政策冲突，继续保留 startup-preferences。
- `8800b5a` 的上游 provider 开关界面本地不存在；现有模型切换错误仍沿用本地机制，另外给 ModelScope 的空选择 Save 禁用原因增加可见说明。
- 不导入浏览器 cookie 登录、整个 MCP/subagent 迁移、侧栏重设计或上游 release/version 提交。
- 保留本地 `PI_WEB_SESSION_IDLE_TIMEOUT_MS`；新增有限清理设置 `PI_WEB_SHUTDOWN_DEADLINE_MS`（默认 5 秒）和 SSE 积压设置 `PI_WEB_SSE_BACKLOG_LIMIT_BYTES`（默认 16 MB）。

## 验证

- TypeScript：`node node_modules/typescript/bin/tsc --noEmit` 通过。
- ESLint：`npm run lint -- --max-warnings=0` 通过。
- 最终全库测试：231 个测试文件，1,673 项；1,641 通过，28 跳过，4 失败。
- 4 个失败与修改前基线一致，均发生在 MCP 安全测试创建 Windows symlink 时的 `EPERM`，尚未执行到安全断言。未弱化测试或修改操作系统权限以掩盖此限制。
- `npm audit --omit=dev`：0。完整 `npm audit --include=dev` 仍报告 13 个包项（5 high、3 moderate、5 low），主要为 braces/ESLint、KaTeX/数学渲染、mammoth/sprintf-js 等链条；建议修复涉及破坏性升级或降级，未使用 `--force`。其中存在前端预览依赖，不能把 omit=dev 为 0 理解为整个产物完全无风险。
- 未运行 `next build`，未发布新版本。
