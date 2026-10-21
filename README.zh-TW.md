# Pi Web

[简体中文](./README.md) · 繁體中文 · [English](./README.en.md)

為 [Pi 編碼代理](https://github.com/earendil-works/pi) 打造的多功能 Web 介面，同時提供 **Windows 桌面用戶端（Pi Desktop）**。介面參考 Kimi Code 的工作區佈局，強調長對話、多專案與可追溯的操作。

Pi Web 與 Pi CLI **共用同一份設定與會話儲存**（`~/.pi/agent`）：在瀏覽器或桌面端建立的會話，CLI 可以直接開啟，反之亦然。

本倉庫是 [`agegr/pi-web`](https://github.com/agegr/pi-web) 的分支，在保留上游 Web 體驗的基礎上，增加了 Windows 桌面外殼、遠端目錄掛載、內建子代理、統一會話管理等能力。

## 兩種執行形態

| 形態 | 說明 |
| --- | --- |
| **Pi Desktop（Windows）** | Tauri + WebView2 外殼，內建 Node 執行環境與完整 server，**無需安裝 Node.js**。具備系統匣、關閉即最小化、自動更新。 |
| **瀏覽器版** | `npm run dev` 本機開發，或部署到區域網路／伺服器，以瀏覽器存取。 |

## 功能

### 會話與工作區

- 側邊欄依 **專案／Git 工作樹** 分組呈樹狀，支援折疊、搜尋、置頂、封存與移除專案。
- **兩種分支方式**：從任一歷史訊息 Fork 出獨立會話檔；或在同一會話內切換／新增分支（分支導覽器）。
- 會話重新命名、匯出為獨立 HTML、結果卡呈現本輪變更檔案與宣告式交付物。
- **統一會話管理**：置頂、封存、永久刪除（二次確認）、跨視窗狀態同步；封存會話以唯讀方式檢視，仍保留即時狀態與完成提醒。
- 長會話最佳化：串流內容獨立訂閱、訊息視窗按需分頁、回合小地圖與捲軸、整個分支的回合索引。

### 對話與推理

- SSE 串流輸出，斷線自動重連；背景分頁以輪詢對帳，避免漏掉終態事件。
- 執行中可 **引導插隊（steering）**，訊息併入目前回合而不打斷它。
- 思考等級依模型能力過濾，**主模型與配額備援模型各自獨立**。
- 上下文佔用環形指示、手動壓縮與自動壓縮狀態提示。
- 已完成回合的耗時與 token 統計（歷史會話依記錄回顯，缺失時標註為估算）。

### 模型與配額

- 供應商登入（OAuth／裝置碼／手動授權碼）與 API Key 管理，金鑰僅存於 Pi 的 `auth.json`，狀態介面不回傳明文。
- 模型設定中心：`models.json` 編輯、models.dev 價格預設、上游模型探索、連線測試。
- **模型作用域**（`enabledModels`）：與 Pi CLI 的 `--models` 語意一致，支援萬用字元與 `:thinkingLevel` 後綴。
- **配額故障轉移**：僅在額度類錯誤時切換到備援模型，備援模型帶自己的思考等級；本輪結束（成功／失敗／停止）後回復主模型，並在重新開啟會話時修復未完成的切換。

### 自動化與工具

- **自動推進（Auto Advance）**：由伺服器持有、記憶體態、不隨重新整理存活；最多 1–99 輪，由無工具的判定模型輸出 `continue / complete / needs_user` 嚴格 JSON；遇到阻塞式互動、手動輸入、封存或設定變更即失敗關閉。
- **工具預設組**：全部／預設／唯讀／僅聊天。僅聊天模式不載入擴充、技能、提示範本與主題，只保留 Pi 探索到的上下文物件。
- **內建子代理**：`Agent`、`get_subagent_result`、`steer_subagent`；背景子代理**結果只拉不推**，避免多餘的模型回合。
- **MCP**：管理 stdio 與 HTTP/SSE 伺服器，設定寫入 Pi 的 `mcp.json`，支援 OAuth。
- **外掛與技能**：全域／專案套件管理（安裝、更新、啟停）、技能模型呼叫開關、`npx skills add` 安裝與 skills.sh 搜尋。
- **宣告式交付物**：`present_files` 只在允許的根目錄內做唯讀校驗，不讀內容、不執行 HTML、不自動開啟。
- **結構化問卷**：`ask_user_question` 提供 1–4 道帶選項的提問，回答以工具結果回到同一輪；使用者關閉視為拒絕，不會猜預設值。

### 檔案與遠端

- 檔案瀏覽器、語法醒目提示、Markdown（KaTeX 公式與 Mermaid 圖）、圖片與附件預覽／上傳、編輯錨點。
- **Git diff**：對已追蹤變更與倉庫內新檔案給出紅綠差異；無差異時明確說明原因（與 HEAD 一致／被忽略／不在倉庫內／二進位／過大）。
- 檔案存取受允許根目錄約束（會話 cwd、專案根、明確加入的目錄），並校驗真實路徑以防越權。
- **遠端專案**：SSH 主機管理（金鑰或密碼）、遠端目錄選擇器、透過 SSHFS/UNC 將遠端目錄掛載成本機工作目錄。

### 介面與平台

- 淺色／深色／跟隨系統，四段字級，簡體中文／繁體中文／English（系統匣文案同語言）。
- PWA 與行動版佈局（含行動工具列、安全區適配）。
- **用量面板**：依專案、供應商、模型聚合，支援時間範圍（含時區）、歷史成本直讀不重算。
- **Pi Desktop**：系統匣（顯示、新增會話、最近會話、結束）、關閉即最小化至系統匣、以系統程式開啟檔案／在檔案總管中顯示、自動更新（簽章校驗）。

## 快速開始

### Windows 桌面版（建議）

從 [GitHub Releases](https://github.com/ghost0211/pi-web/releases/latest) 下載最新的 `Pi-Web-Desktop_*_x64-setup.exe` 安裝即可，無需安裝 Node.js。

- 安裝包身分維持 **Pi Web Desktop** 以相容升級，桌面捷徑顯示為 **pi**。
- 自動更新走 GitHub Releases 的 `desktop-latest.json`，安裝包具 minisign 簽章。
- 資料（會話、設定、憑證）沿用 `~/.pi/agent`，與 CLI 及其他用戶端共享。

### 從原始碼執行

需要 **Node.js ≥ 22.19.0**：

```bash
git clone https://github.com/ghost0211/pi-web.git
cd pi-web
npm install
npm run dev          # http://127.0.0.1:30141
```

正式模式（本機已建置時）：

```bash
npm run build
npm start            # 或 npm run start:lan 監聽 0.0.0.0
```

> 注意：本分支不發佈 npm 套件。`npx @agegr/pi-web` 安裝的是上游發佈的程式碼，不是本倉庫的功能版本。

### 桌面版開發

```bash
npm run dev            # 終端 1：Web 開發伺服器（30141）
npm run desktop:dev    # 終端 2：Tauri 外殼，附著到 30141，不再啟動 sidecar
```

打包安裝程式需先組裝 server 與 Node 執行環境，再執行 `tauri build`：

```bash
npm run desktop:server   # 產生 src-tauri/server 與 src-tauri/node
npm run desktop:build    # NSIS 安裝包（含簽章與 server 啟動 smoke）
```

細節見 [`desktop/README.md`](./desktop/README.md) 與 [`docs/adr/0004-windows-desktop-tauri.md`](./docs/adr/0004-windows-desktop-tauri.md)。

## 設定

命令列參數優先於環境變數。

| 參數／環境變數 | 說明 | 預設值 |
| --- | --- | --- |
| `-p, --port <port>` / `PORT` | 監聽埠 | `30141` |
| `-H, --hostname <host>` / `PI_WEB_HOSTNAME` | 綁定位址 | `127.0.0.1` |
| `--no-open` / `PI_WEB_NO_OPEN=1` | 不自動開啟瀏覽器 | 關閉 |
| `--unsafe-no-auth` / `PI_WEB_UNSAFE_NO_AUTH=1` | 明確允許無認證的非回環存取 | 關閉 |
| `PI_WEB_PASSWORD` | 啟用 HTTP Basic Auth（使用者名稱固定為 `pi`） | 未啟用 |
| `PI_WEB_ALLOWED_HOSTS` | 額外允許的代理／自訂主機名，逗號分隔 | 未設定 |
| `PI_WEB_ALLOWED_DEV_ORIGINS` | 開發伺服器額外允許的來源 | 未設定 |
| `PI_CODING_AGENT_DIR` | Pi 代理設定目錄 | `~/.pi/agent` |
| `PI_WEB_SESSION_IDLE_TIMEOUT_MS` | 閒置會話回收時間（`0` 關閉） | `600000`（10 分鐘） |
| `PI_WEB_DESKTOP` / `PI_WEB_SKIP_VERSION_CHECK` | 由桌面外殼設定，標記桌面環境並略過 npm 版本檢查 | — |
| `HTTP_PROXY` / `HTTPS_PROXY` | 模型請求與網路查詢使用的代理 | 未設定 |

### 區域網路／伺服器部署

綁定非回環位址時預設要求認證：

```bash
PI_WEB_PASSWORD='一個強密碼' pi-web -H 0.0.0.0 -p 30141 --no-open
```

Basic Auth 走明文 HTTP **不會加密**密碼，請置於 HTTPS 反向代理之後，或只在受信 VPN 內使用。`--unsafe-no-auth` 僅用於隔離的可信網路。

### 資料與目錄

```
~/.pi/agent/
  settings.json              預設模型、思考等級、compaction、enabledModels 等
  models.json                自訂供應商與模型
  auth.json                  OAuth / API Key 憑證
  ssh-hosts.json             遠端主機（密碼存於本機）
  agents/settings.json       內建子代理開關與代理檔案
  pi-web/session-management.json  置頂／封存等 Pi Web 自有中繼資料
  sessions/<編碼後的 cwd>/*.jsonl 會話檔
```

## 開發與測試

```bash
npm run dev                                  # 開發伺服器
node node_modules/typescript/bin/tsc --noEmit   # 型別檢查
npm run lint                                 # ESLint
npm test                                     # node --test（單元／整合）
node --test desktop-branding.test.mjs desktop-installer.test.mjs   # 桌面外殼與安裝器
```

慣例與陷阱（會話生命週期、SSE 對帳、分支語意、路由匯出限制、桌面打包完整性等）記錄於 [`AGENTS.md`](./AGENTS.md)。

## 倉庫結構

```text
app/          Next.js App Router 頁面與 API 路由
components/   介面元件（側邊欄、聊天、設定、檔案檢視器等）
hooks/        狀態、串流、主題、快速鍵等 React hooks
lib/          核心邏輯：SDK 封裝、會話讀取、模型與配額、子代理、安全邊界
bin/          CLI 入口與啟動參數
desktop/      桌面外殼的載入頁
src-tauri/    Tauri 2 外殼（系統匣、更新、安裝器掛鉤）
docs/         架構說明、ADR、SDK 適配記錄
scripts/      桌面打包、bundle 校驗、server 啟動 smoke
```

## 文件

- [`docs/adr/`](./docs/adr)：架構決策記錄（僅聊天工具選擇、內建子代理開關、桌面外殼、統一會話管理）
- [`docs/auto-advance.md`](./docs/auto-advance.md)：自動推進的邊界與失敗關閉條件
- [`docs/model-fallback-quota-errors.md`](./docs/model-fallback-quota-errors.md)：配額故障轉移
- [`docs/mobile-web-layout.md`](./docs/mobile-web-layout.md)：行動版佈局
- [`docs/run-timing.md`](./docs/run-timing.md)：執行耗時記錄
- [`docs/i18n.md`](./docs/i18n.md)：多語言與語言外掛
- [`docs/pi-sdk-*.md`](./docs)：歷次 Pi SDK 升級的適配與驗證記錄
- [`docs/release.md`](./docs/release.md)：發佈流程

## 與上游的關係

本倉庫是 `agegr/pi-web` 的分支，採取**選擇性移植**而非整體合併：桌面外殼、遠端掛載、內建子代理、統一會話管理、配額故障轉移、自動推進、用量面板等是本分支的能力；上游的通用改進按需移植。

## 授權

[MIT](./LICENSE)
