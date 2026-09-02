# Pi Web

[English](./README.md)

[Pi 编程智能体](https://github.com/earendil-works/pi)的现代化本地 Web 端界面，参考 Kimi Code Web 交互体验进行了深度重构与体验优化。

Pi Web 与 Pi 命令行直接共享本机配置、凭据与会话记录，支持在浏览器中按项目管理工作区、浏览与分支会话、监控后台任务、可视化配置模型与扩展资源。

## 功能亮点

- **对齐 Kimi Code 的工作区布局**：
  - **项目与会话目录树**：按项目根目录与 Git Worktree 分组聚合，支持文件夹展开/折叠状态图标联动、项目选项菜单（新建会话、复制路径、从列表中移除）与快速搜索过滤。
  - **两种分支模式**：支持从历史消息派生全新独立会话（Fork），或在当前会话内创建编辑分支。
  - **全新设置中心**：左侧标签导航 + 右侧子标签架构（常规：外观显示 / 自动化 / 环境设置；模型配置；技能管理；插件管理）。
  - **丰富的外观个性化**：亮色 / 暗色 / 跟随系统主题，多档字体大小调节（小 / 标准 / 大 / 特大），完整支持中英文多语言切换。
- **强大的会话与任务管理**：
  - **实时 SSE 流式传输**：丝滑打字机输出，断线自动重连，后台标签页自动同步。
  - **后台任务指示坞（Task Dock）**：实时展示后台异步任务、子代理及工具调用进度与结果。
  - **会话操作**：支持重命名、二次确认删除、智能自动命名会话标题、一键导出为独立离线 HTML。
- **模型与扩展生态**：
  - **全能模型配置中心**：支持各大主流 Provider（OpenAI、Anthropic、Gemini、DeepSeek、本地模型等）的 OAuth 与 API Key 管理，提供即时可用性测试与定价填充。
  - **技能与插件管理**：支持管理 `.agents/skills` 技能目录、npm/git 插件包及本地独立扩展脚本（`~/.pi/agent/extensions/*.ts`）。
- **文件浏览与代码审查**：
  - 内置文件资源管理器、代码高亮、Markdown 公式（KaTeX）、Mermaid 图表以及实时 Git Diff 差异对比。
- **PWA 与移动端体验**：
  - 渐进式 Web 应用（PWA）支持，离线缓存优化，移动端自适应操作栏与底部工具条。

## 快速开始

### 环境要求
- Node.js `22.19.0` 或更高版本（可用 `node -v` 检查）。

### 直接运行

```bash
# 使用 npx 直接运行
npx @agegr/pi-web@latest

# 或全局安装使用
npm install -g @agegr/pi-web@latest
pi-web
```

启动完成后会自动在默认浏览器中打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。

### 本地开发

```bash
git clone https://github.com/ghost0211/pi-web.git
cd pi-web
npm install
npm run dev
```

在浏览器中访问 `http://localhost:30141` 即可开始开发调试。

### Windows 桌面端

项目提供 Windows 桌面客户端 —— **Pi Web Desktop**（Tauri + WebView2，内置 Node.js 运行时，无需单独安装 Node.js）。可通过 `npm run desktop:build` 本地构建 NSIS 安装包，或使用 CI 工作流构建；详见 [`desktop/README.md`](./desktop/README.md)。

## 启动参数与环境变量

命令行参数优先级高于对应的环境变量：

| 参数 / 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动参数帮助信息并退出 | — |
| `--port <端口>`、`-p` 或 `PORT` | 服务监听端口 | `30141` |
| `--hostname <主机>`、`-H` 或 `PI_WEB_HOSTNAME` | 绑定的主机地址 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 启动后不自动打开浏览器 | `false` |
| `PI_WEB_PASSWORD` | 启用 HTTP Basic Auth 认证（用户名固定为 `pi`） | 未启用 |
| `PI_WEB_ALLOWED_HOSTS` | 允许的主机名/反向代理白名单（逗号分隔） | 未设置 |
| `PI_CODING_AGENT_DIR` | 自定义 Pi Agent 配置数据目录 | `~/.pi/agent` |

### 局域网 / 远程服务器部署

如需监听 `0.0.0.0` 供局域网其他设备访问，建议设置访问密码：

```bash
PI_WEB_PASSWORD='设置你的强密码' pi-web -H 0.0.0.0 -p 30141 --no-open
```

### 代理设置

服务端模型请求与网络调用遵循标准代理环境变量：

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 pi-web
```

## 测试与代码质量

```bash
# 运行全量单元测试与集成测试
npm test

# 运行 TypeScript 类型检查
node_modules/.bin/tsc --noEmit

# 运行 ESLint 代码检查
npm run lint
```

## 目录结构

```text
app/             Next.js App Router 页面、布局、样式及后端 API 路由
components/      React 组件（SettingsPanel、ChatWindow、SessionSidebar 等）
hooks/           状态管理、流式处理、主题、字号及快捷键 Hooks
lib/             核心业务逻辑、SDK 适配层、文件安全及多语言国际化
public/          静态图标、PWA manifest 与 Service Worker
bin/             CLI 入口与启动参数解析
docs/            架构设计文档、指南与 ADR
```

## 开源协议

[MIT](./LICENSE)
