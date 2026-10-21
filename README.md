# Pi Web

简体中文 · [繁體中文](./README.zh-TW.md) · [English](./README.en.md)

为 [Pi 编码代理](https://github.com/earendil-works/pi) 打造的多功能 Web 界面，同时提供 **Windows 桌面客户端（Pi Desktop）**。界面参考 Kimi Code 的工作区布局，强调长会话、多项目与可追溯的操作。

Pi Web 与 Pi CLI **共用同一份配置和会话存储**（`~/.pi/agent`）：在浏览器或桌面端创建的会话，CLI 里可以直接打开，反之亦然。

本仓库是 [`agegr/pi-web`](https://github.com/agegr/pi-web) 的分支，在保留上游 Web 体验的基础上，增加了 Windows 桌面壳、远程目录挂载、内置子代理、统一会话管理等能力。

## 两种运行形态

| 形态 | 说明 |
| --- | --- |
| **Pi Desktop（Windows）** | Tauri + WebView2 外壳，内置 Node 运行时与完整 server，**无需安装 Node.js**。带托盘、关闭最小化、自动更新。 |
| **浏览器版** | `npm run dev` 本地开发，或部署到局域网/服务器，用浏览器访问。 |

## 功能

### 会话与工作区

- 侧边栏按 **项目 / Git 工作树** 分组建树，支持折叠、搜索、置顶、归档与移除项目。
- **两种分支方式**：从任意历史消息 Fork 出独立会话文件；或在同一会话内切换/新增分支（分支导航器）。
- 会话重命名、导出为独立 HTML、结果卡展示本轮改动文件与声明式交付物。
- **统一会话管理**：置顶、归档、永久删除（二次确认）、跨窗口状态同步；归档会话以只读方式查看，仍保留实时状态与完成提醒。
- 长会话优化：流式内容独立订阅、消息窗口按需分页、回合小地图与滚动条、整个分支的回合索引。

### 对话与推理

- SSE 流式输出，断线自动重连；后台标签页通过轮询对账，避免漏掉终态事件。
- 运行中可 **引导插队（steering）**，消息并入当前回合而不打断它。
- 思考档位按模型能力过滤，**主模型与配额备用模型各自独立**。
- 上下文占用环形指示、手动压缩与自动压缩状态提示。
- 已完成回合的耗时与 token 统计（历史会话按记录回显，缺失时标注为估算）。

### 模型与配额

- 供应商登录（OAuth / 设备码 / 手动授权码）与 API Key 管理，密钥仅存于 Pi 的 `auth.json`，状态接口不回传明文。
- 模型配置中心：`models.json` 编辑、models.dev 价格预设、上游模型发现、连通性测试。
- **模型作用域**（`enabledModels`）：与 Pi CLI 的 `--models` 语义一致，支持通配与 `:thinkingLevel` 后缀。
- **配额故障转移**：仅在额度类错误时切到备用模型，备用模型带自己的思考档位；本轮结束（成功/失败/停止）后恢复主模型，并在重开会话时修复未完成的切换。

### 自动化与工具

- **自动推进（Auto Advance）**：服务端持有、内存态、不随刷新存活；最多 1–99 轮，由无工具的判定模型输出 `continue / complete / needs_user` 严格 JSON；遇到阻塞式交互、手动输入、归档或配置变更即失败关闭。
- **工具预设**：全量 / 默认 / 只读 / 仅聊天。仅聊天模式不加载扩展、技能、提示模板与主题，只保留 Pi 发现的上下文文件。
- **内置子代理**：`Agent`、`get_subagent_result`、`steer_subagent`；后台子代理**结果只拉不推**，避免额外的模型回合。
- **MCP**：管理 stdio 与 HTTP/SSE 服务器，配置写入 Pi 的 `mcp.json`，支持 OAuth。
- **插件与技能**：全局/项目包管理（安装、更新、启停）、技能模型调用开关、`npx skills add` 安装与 skills.sh 搜索。
- **声明式交付物**：`present_files` 只在允许的根目录内做只读校验，不读内容、不执行 HTML、不自动打开。
- **结构化问卷**：`ask_user_question` 提供 1–4 道带选项的提问，回答作为工具结果回到同一轮；用户关闭视为拒绝，不会猜默认值。

### 文件与远程

- 文件浏览器、语法高亮、Markdown（KaTeX 公式与 Mermaid 图）、图片与附件预览/上传、编辑锚点。
- **Git diff**：对已跟踪改动与仓库内新文件给出红绿差异；无差异时明确说明原因（与 HEAD 一致 / 被忽略 / 不在仓库内 / 二进制 / 过大）。
- 文件访问受允许根目录约束（会话 cwd、项目根、显式添加的目录），并校验真实路径以防越权。
- **远程项目**：SSH 主机管理（密钥或密码）、远端目录选择器、通过 SSHFS/UNC 把远端目录挂载成本地工作目录。

### 界面与平台

- 浅色 / 深色 / 跟随系统，四档字号，简体中文 / 繁体中文 / English（托盘文案同语言）。
- PWA 与移动布局（含移动工具栏、安全区适配）。
- **用量面板**：按项目、供应商、模型聚合，支持时间范围（含时区）、历史成本直读不重算。
- **Pi Desktop**：托盘（显示、新建会话、最近会话、退出）、关闭最小化到托盘、文件用系统程序打开/在资源管理器中显示、自动更新（签名校验）。

## 快速开始

### Windows 桌面版（推荐）

从 [GitHub Releases](https://github.com/ghost0211/pi-web/releases/latest) 下载最新的 `Pi-Web-Desktop_*_x64-setup.exe` 安装即可，无需安装 Node.js。

- 安装包身份保持 **Pi Web Desktop** 以兼容升级，桌面快捷方式显示为 **pi**。
- 自动更新走 GitHub Releases 的 `desktop-latest.json`，安装包带 minisign 签名。
- 数据（会话、配置、凭据）沿用 `~/.pi/agent`，与 CLI 及其他客户端共享。

### 从源码运行

需要 **Node.js ≥ 22.19.0**：

```bash
git clone https://github.com/ghost0211/pi-web.git
cd pi-web
npm install
npm run dev          # http://127.0.0.1:30141
```

生产模式（本地已构建时）：

```bash
npm run build
npm start            # 或 npm run start:lan 监听 0.0.0.0
```

> 注意：本分支不发布 npm 包。`npx @agegr/pi-web` 安装的是上游发布的代码，不是本仓库的功能版本。

### 桌面版开发

```bash
npm run dev            # 终端 1：Web 开发服务器（30141）
npm run desktop:dev    # 终端 2：Tauri 外壳，附着到 30141，不再启动 sidecar
```

打包安装程序需要先组装 server 与 Node 运行时，再执行 `tauri build`：

```bash
npm run desktop:server   # 生成 src-tauri/server 与 src-tauri/node
npm run desktop:build    # NSIS 安装包（含签名与 server 启动 smoke）
```

细节见 [`desktop/README.md`](./desktop/README.md) 与 [`docs/adr/0004-windows-desktop-tauri.md`](./docs/adr/0004-windows-desktop-tauri.md)。

## 配置

命令行参数优先于环境变量。

| 参数 / 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `-p, --port <port>` / `PORT` | 监听端口 | `30141` |
| `-H, --hostname <host>` / `PI_WEB_HOSTNAME` | 绑定地址 | `127.0.0.1` |
| `--no-open` / `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 关闭 |
| `--unsafe-no-auth` / `PI_WEB_UNSAFE_NO_AUTH=1` | 显式允许无认证的非回环访问 | 关闭 |
| `PI_WEB_PASSWORD` | 启用 HTTP Basic Auth（用户名固定为 `pi`） | 未启用 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理/自定义主机名，逗号分隔 | 未设置 |
| `PI_WEB_ALLOWED_DEV_ORIGINS` | 开发服务器额外允许的来源 | 未设置 |
| `PI_CODING_AGENT_DIR` | Pi 代理配置目录 | `~/.pi/agent` |
| `PI_WEB_SESSION_IDLE_TIMEOUT_MS` | 空闲会话回收时间（`0` 关闭） | `600000`（10 分钟） |
| `PI_WEB_DESKTOP` / `PI_WEB_SKIP_VERSION_CHECK` | 由桌面外壳设置，标记桌面环境并跳过 npm 版本检查 | — |
| `HTTP_PROXY` / `HTTPS_PROXY` | 模型请求与网络查询使用的代理 | 未设置 |

### 局域网 / 服务器部署

绑定非回环地址时默认要求认证：

```bash
PI_WEB_PASSWORD='一个强密码' pi-web -H 0.0.0.0 -p 30141 --no-open
```

Basic Auth 走明文 HTTP **不会加密**密码，请置于 HTTPS 反向代理之后，或只在受信 VPN 内使用。`--unsafe-no-auth` 仅用于隔离的可信网络。

### 数据与目录

```
~/.pi/agent/
  settings.json              默认模型、思考档位、compaction、enabledModels 等
  models.json                自定义供应商与模型
  auth.json                  OAuth / API Key 凭据
  ssh-hosts.json             远程主机（密码以本机存储）
  agents/settings.json       内置子代理开关与代理档案
  pi-web/session-management.json  置顶/归档等 Pi Web 自有元数据
  sessions/<编码后的 cwd>/*.jsonl 会话文件
```

## 开发与测试

```bash
npm run dev                                  # 开发服务器
node node_modules/typescript/bin/tsc --noEmit   # 类型检查
npm run lint                                 # ESLint
npm test                                     # node --test（单元/集成）
node --test desktop-branding.test.mjs desktop-installer.test.mjs   # 桌面壳与安装器
```

约定与陷阱（会话生命周期、SSE 对账、分支语义、路由导出限制、桌面打包完整性等）记录在 [`AGENTS.md`](./AGENTS.md)。

## 仓库结构

```text
app/          Next.js App Router 页面与 API 路由
components/   界面组件（侧边栏、聊天、设置、文件查看器等）
hooks/        状态、流式、主题、快捷键等 React hooks
lib/          核心逻辑：SDK 封装、会话读取、模型与配额、子代理、安全边界
bin/          CLI 入口与启动参数
desktop/      桌面外壳的加载页
src-tauri/    Tauri 2 外壳（托盘、更新、安装器钩子）
docs/         架构说明、ADR、SDK 适配记录
scripts/      桌面打包、bundle 校验、server 启动 smoke
```

## 文档

- [`docs/adr/`](./docs/adr)：架构决策记录（仅聊天工具选择、内置子代理开关、桌面外壳、统一会话管理）
- [`docs/auto-advance.md`](./docs/auto-advance.md)：自动推进的边界与失败关闭条件
- [`docs/model-fallback-quota-errors.md`](./docs/model-fallback-quota-errors.md)：配额故障转移
- [`docs/mobile-web-layout.md`](./docs/mobile-web-layout.md)：移动端布局
- [`docs/run-timing.md`](./docs/run-timing.md)：运行耗时记录
- [`docs/i18n.md`](./docs/i18n.md)：多语言与语言插件
- [`docs/pi-sdk-*.md`](./docs)：历次 Pi SDK 升级的适配与验证记录
- [`docs/release.md`](./docs/release.md)：发布流程

## 与上游的关系

本仓库是 `agegr/pi-web` 的分支，采取**选择性移植**而非整体合并：桌面壳、远程挂载、内置子代理、统一会话管理、配额故障转移、自动推进、用量面板等是本分支的能力；上游的通用改进按需移植。

## 许可

[MIT](./LICENSE)
