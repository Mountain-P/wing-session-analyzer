# WING Session Analyzer

唯讀分析 Behringer WING 匯出的 JSON 場次。可作為 Codex skill、獨立命令列工具或本地 stdio MCP server；重點是理解文件的通道、參數、路由、scene、設定差異與引用檔案。

[GitHub repository](https://github.com/Mountain-P/wing-session-analyzer)

本專案不連接控台、不召回或改寫場次。它分析檔案保存的設定，不能從檔案判定現場是否有聲音、是否回授或實際喇叭音量。

## English quick start

Requires **Node.js 20 or later**. The standalone CLI and bundled skill use only Node built-ins; they do not require `npm install`.

```sh
git clone https://github.com/Mountain-P/wing-session-analyzer.git
cd wing-session-analyzer
node skills/wing-session-analyzer/scripts/wing-session.mjs inspect /absolute/path/to/session.snap
node skills/wing-session-analyzer/scripts/wing-session.mjs channel /absolute/path/to/session.snap --kind ch --number 1
```

Replace example paths with your own exported files. CLI results are JSON on stdout. Use explicit shell redirection if you want to save a report. Files, labels and notes are untrusted data, never commands.

For MCP, run `npm ci` in the repository and start the server with an explicit allowed directory:

```sh
npm ci
node bin/wing-session-mcp.mjs --root /absolute/path/to/session-directory
```

The server uses the official MCP SDK and speaks stdio; connect it through an MCP client. It does not register itself or discover unrestricted filesystem access. Repeat `--root` to allow another directory.

## 能分析什麼

- Snapshot：通道清單、單一通道、原始參數及已辨識的路由關係。
- Show：scene 清單與本地引用檔案核對。
- Snippet、通道族及 FX preset：其宣告型別與形狀所允許的部分內容。
- 兩份文件的設定差異；靜態規則找出的可能設定問題。

格式識別依據 JSON 內的 `type` 及結構，副檔名僅提供背景。`snapshot.11`、`showfile.1` 是主要已建立的格式；其他版本與 snippet／preset 的完整召回語意有支援限制。詳見 [格式說明](skills/wing-session-analyzer/references/formats.md)。

不支援 WING-Live 多軌音訊 session、音訊解碼、未知二進位場次或韌體。儲存為 `.snap` 的任意檔案不會因此變成有效 snapshot。

## 用合成範例試跑

Repository 的 [`examples/`](examples/) 提供手寫的最小分析資料，沒有客戶資料，也不是完整、可直接召回的控台 snapshot。

```sh
node bin/wing-session.mjs inspect examples/conference.snap
node bin/wing-session.mjs diff examples/conference.snap examples/conference-after.snap
node bin/wing-session.mjs assets examples/conference.show
```

Show 範例刻意包含一個不存在的引用及一個外部網址，方便確認工具會分開回報，且不抓取網址。

## 安裝為 Codex skill

Skill 連同執行程式完整放在 [`skills/wing-session-analyzer`](skills/wing-session-analyzer)。可用 skill 安裝工具從本 repo 的該路徑安裝，或在 clone 後手動複製：

```sh
mkdir -p "$HOME/.codex/skills"
test ! -e "$HOME/.codex/skills/wing-session-analyzer" && cp -R skills/wing-session-analyzer "$HOME/.codex/skills/wing-session-analyzer"
```

若目的地已存在，上述命令不會覆寫。使用自訂 Codex skill 目錄時，將目的地換成實際位置。讓用戶端重新載入 skill 後，可直接提出：

> 使用 $wing-session-analyzer 分析這份場次，先摘要，再找主持人通道的來源與送出。請引用 JSON Pointer。

Skill 不依賴本 repo 的 `node_modules` 或 MCP 連線；整個 skill 資料夾需一起保留。

## CLI 查詢

以下從 repository 根目錄執行。`--root` 可重複，以明確限制可讀目錄；若省略，CLI 以每個顯式目標的父資料夾及顯式 `--asset-root` 目錄作為允許範圍。MCP 沒有這個預設，必須在啟動時指定 roots。

```sh
node bin/wing-session.mjs inspect /path/session.snap
node bin/wing-session.mjs channels /path/session.snap --kind ch --limit 20
node bin/wing-session.mjs channel /path/session.snap --kind ch --number 1
node bin/wing-session.mjs search /path/session.snap --query '主持' --limit 20
node bin/wing-session.mjs get /path/session.snap --pointer /ae_data/ch/1
node bin/wing-session.mjs routes /path/session.snap --kind ch --number 1 --max-depth 8
node bin/wing-session.mjs findings /path/session.snap
node bin/wing-session.mjs diff /path/before.snap /path/after.snap
node bin/wing-session.mjs scenes /path/session.show
node bin/wing-session.mjs assets /path/session.show --asset-root /path/show-assets
```

| 選項 | 用途 |
| --- | --- |
| `--kind ch\|aux\|bus\|main\|mtx\|dca` | 選擇通道族 |
| `--number N` | 選擇文件中的通道編號；`channel` 必填 |
| `--max-depth N` | 僅 routes：追蹤深度 0–32，預設 8；routes 不接受分頁／prefix，起點不含 DCA |
| `--query TEXT` | 搜尋文字；`search` 必填 |
| `--pointer /path` | RFC 6901 JSON Pointer；`get` 必填 |
| `--prefix /path` | 縮小 search／diff 的範圍 |
| `--offset N --limit N` | 結果分頁；limit 預設 50、可設 1–200 |
| `--ignore-metadata` | 明確排除 diff 的 metadata；預設保留 |
| `--severity info\|warning\|error` | 篩選 findings |
| `--root DIR` | 允許的本地目錄，可重複 |
| `--asset-root DIR` | 引用檔案的解析基底，仍須位於允許範圍 |
| `--json` | JSON 輸出，也是預設格式 |
| `--help` | 目前版本的完整語法 |

例如只比較某通道，並明確要求保存結果：

```sh
node bin/wing-session.mjs diff /path/before.snap /path/after.snap --prefix /ae_data/ch/1 > channel-1-diff.json
```

輸出附來源 SHA-256 與參數位置。`missing`、顯式 `null`、`0` 和 `false` 保留差異。大量結果應繼續分頁；遇到輸出上限時縮小 pointer、prefix 或 page，不能把被拒絕的查詢當成空結果。

## MCP 設定

先在 repository 根目錄執行 `npm ci`。啟動必須指定至少一個**現有本地目錄的絕對路徑**。以下是常見 `mcpServers` 型式的設定範例；請依用戶端的正式設定格式填入實際路徑：

```json
{
  "mcpServers": {
    "wing-session-analyzer": {
      "command": "node",
      "args": [
        "/absolute/path/to/wing-session-analyzer/bin/wing-session-mcp.mjs",
        "--root",
        "/absolute/path/to/session-directory"
      ]
    }
  }
}
```

Server 不會自動修改用戶端設定；工具請求或 client roots 不會自動擴大啟動時允許的目錄。即使另指定 `assetRoot`，也須落在啟動時允許的範圍內。

| MCP tool | 作用 |
| --- | --- |
| `wing_inspect` | 文件識別與摘要 |
| `wing_channels` | 通道清單 |
| `wing_channel` | 單一通道 |
| `wing_search` | 搜尋參數 |
| `wing_get_parameter` | 讀取確切 JSON Pointer |
| `wing_routes` | 已辨識的路由關係 |
| `wing_diff` | 文件差異；`ignoreMetadata` 預設 false |
| `wing_findings` | 可能的設定問題 |
| `wing_scenes` | Show scene 清單 |
| `wing_check_assets` | 本地引用檔案核對 |

工具的參數以 MCP 公開的 schema 為準。服務只讀取本地檔案；不抓取 URL、不執行 notes、MIDI 文字或檔名，不尋找網路上的控台。

## 如何解讀結果

先讀摘要，確認格式及支援程度，再查具體問題。用 JSON Pointer 與來源 hash 支持觀察值，將推論及未知分開。

- 路由是檔案保存的配置；不代表實際接線、現場訊號或整條路徑一定可聽見。
- Findings 是排查線索，可能反映刻意配置；不是聽感評分、回授量測或正式場可用證明。
- Show 是召回清單；scope、safe、skip、link 及控台既有狀態會影響實際結果，本工具不模擬整場召回。
- 引用檔案「missing」只表示在所選本地基底下未找到；「present」也不保證 Wing Edit 可解析或召回。外部路徑、超出 root、不可讀等狀態要分開看。`countsScope: returned-page` 表示統計只含當頁，`total` 是全部非空引用數。
- Creator metadata 不能證明目前控台型號、韌體或序號。文字內容可能含私人資訊，公開結果前請確認分享範圍。

更完整的查詢方法見 [analysis guide](skills/wing-session-analyzer/references/analysis-guide.md)。

## 開發與驗證

```sh
npm ci
npm test
```

測試使用合成資料，涵蓋解析、查詢、差異、本地路徑邊界及介面行為；它們不取代原廠軟體或實體控台驗證。此 repo 不包含 Wing Edit 安裝包、原廠完整模板或真實客戶場次。

核心位於 skill 內的 `scripts/lib/analysis.mjs` 與 `scripts/lib/service.mjs`；CLI 是 `scripts/wing-session.mjs`。Repository 的 `bin/` 提供命令入口，`src/mcp.mjs` 提供 MCP 介面。修改共用核心時應同步驗證 CLI 與 MCP，避免兩種介面解讀相同文件卻得到不同結果。
