# 多份場次、比較與報告

## 接收第一批場次

使用使用者明確提供或指定的本地 JSON 場次。可一次指定 1–100 個檔案；不自動掃描附近資料夾、不因 Show 引用而把所有檔案納入分析。Show 缺檔問題另外用 `assets` 核對。ZIP、WING-Live 音訊及未知二進位內容不是本分析器的直接輸入。

CLI／封裝工具省略 `--root` 時，從輸入檔案父目錄推導讀取範圍；父目錄不存在時使用最近的現有上層目錄，以逐檔回報缺檔。明確的 baseline 與 `--asset-root` 也參與預設範圍推導。這不會掃描上層目錄或自行發現其他來源。顯式 `--root` 仍必須是現有目錄；MCP 必須顯式設定 roots，沒有這個推導預設。

場次用途、麥克風型號、預期輸出及當天問題可幫助解讀，但缺少背景時仍可先分析保存值。通道名稱不是麥克風身分證明；不用名稱猜出接線、用途或最佳參數。

以下 `<skill-dir>` 指已安裝的 skill 目錄。所有檔案路徑需換成實際目標。

```sh
node '<skill-dir>/scripts/wing-session.mjs' index '/sessions/day1.snap' '/sessions/day2.snap'
node '<skill-dir>/scripts/wing-session.mjs' batch '/sessions/day1.snap' '/sessions/day2.snap' --format markdown
node '<skill-dir>/scripts/wing-session.mjs' report '/sessions/day1.snap' --format markdown
```

## 索引與批次報告

`index` 對全部明確選定的檔案建立精簡識別資訊，並依精確位元組 SHA-256 分組重複內容。檔名不同可以是相同內容；hash 不同也可能只是 metadata／空白差異，不能直接說混音設定不同。索引的明細可分頁，完整所選範圍的統計標示 `countsScope: all-selected-files`。

`batch` 逐檔產生標準報告，錯誤記在該檔結果，不會讓其他檔案的成功消失。外層預設每頁 3 個檔案，`--limit` 可設 1–20；嵌入報告先取各區塊前 5 筆，須檢查報告內各區塊的 `hasMore`，需要時改以 `report` 分頁取得。批次統計標示 `countsScope: returned-page`，不是全部所選檔案的成功率。

獨立 report 預設 limit 10，其他一般清單／compare／index 預設 50，均可明確指定 1–200。以 `offset`、`limit`、`total`、`hasMore` 判斷每個區塊的覆蓋；不能只看到成功的外層回應，就宣稱全部通道、findings 或 scenes 已完成閱讀。所有分析回應有 256 KiB 上限，較大明確頁面仍可能被拒絕；遇到 `RESPONSE_TOO_LARGE` 就縮小頁面或改用聚焦查詢，錯誤不是空報告。

分析 CLI 預設輸出 `{ok, result}` JSON。`report`、`compare`、`batch` 可用 `--format markdown` 輸出人可讀報告；錯誤仍以 JSON 回報。batch／index 部分檔案失敗時，仍會回傳成功處理的項目並以 exit code 2 結束；參數／啟動錯誤則為 1。讀取結果及逐檔狀態，不僅依頂層 `ok` 判斷成功。

## 跨場次比較

```sh
node '<skill-dir>/scripts/wing-session.mjs' compare '/sessions/rehearsal.snap' '/sessions/final.snap' --format markdown
node '<skill-dir>/scripts/wing-session.mjs' compare '/sessions/rehearsal.snap' '/sessions/final.snap' --prefix '/ae_data/ch/1' --limit 20
```

`compare` 保留原始差異，對已知路徑補上欄位名稱、通道與設定類別，並提供所選比較範圍的變更總數／分組摘要；明細仍須分頁。未知欄位維持原始 Pointer，不憑名稱替未知模型解碼。需要原始差異資料時可使用 `diff`。

比較按文件內相同通道族及編號對齊，沒有自動認定兩份文件的 ch 1 是同一支麥。若通道重排，先查名稱、來源與使用者背景，再解釋變更；不要把槽位差異寫成已確認的同一設備調整。

預設包含 metadata 並保留 missing／null／0／false 的不同。只有任務要求忽略 metadata 時加 `--ignore-metadata`，並交代忽略範圍。使用者指定哪份是基準才依該基準比較，不自行選「最新」或常見設定作為合格標準。重複設定只是觀察，不自動形成個人偏好或最佳實務。

## 保存本地報告

CLI 與 MCP 本身不寫入報告。可以按任務需求將 stdout 另存到明確的報告路徑，保留原始場次。

Skill 隨附獨立的報告封裝工具，可一次建立本地報告資料夾：

```sh
node '<skill-dir>/scripts/wing-session-pack.mjs' \
  --input '/sessions/day1.snap' \
  --input '/sessions/day2.snap' \
  --output '/sessions/reports/run-001' \
  --baseline '/sessions/rehearsal.snap'
```

`--input` 可重複，1–100 個；`--baseline` 選用。讀取根目錄從明確輸入與 baseline 推導，規則同上；可重複 `--root '/allowed/directory'` 進一步限制。輸出資料夾必須尚不存在；可位於來源父目錄下的新子資料夾。工具使用序號命名輸出，不把通道、場次名稱或 note 當檔名。

封裝含 `manifest.json`、`inventory.json`，依選取順序寫入 `sessions/001-report.json`／`.md`。Show 另收集 assets 結果，例如 `sessions/002-assets.json`；有 baseline 時另含 `comparisons/001-comparison.json`／`.md`。同類後續頁加上 `-page-0002` 等尾碼，assets 只輸出 JSON。工具在單頁回應超過上限時自動縮小頁面，收集各報告區塊、比較及引用檢查的全部頁面。

Manifest 記錄選定來源、成功／錯誤、產物及各 stage 的完整性資訊。`complete` 表示所請求的頁面及本地引用檢查均已收集；不代表所有引用存在、未知欄位已解碼、scope／safe 已模擬，或已通過控台／聲學驗證。來源在分頁過程變更會記為錯誤，不能合併不同 hash 的頁面當成同一版。報告產物總計上限 256 MiB；達到上限時以 manifest 記錄未完成階段，應減少選取檔案後改用新的輸出資料夾。部分失敗 exit 2，啟動錯誤 exit 1；不得將封裝資料夾存在當成所有來源成功。

封裝工具只在明確指定的新目錄寫入報告，不是 MCP 工具；repository 的 `bin/wing-session-pack.mjs` 是同一工具的入口。Skill 可獨立執行分析與封裝，無須 npm 套件、下載 repository 或註冊服務。

完整 repository 在執行 `npm ci` 後可用 `npm run doctor` 檢查本機工具。它以合成資料檢查報告、比較、批次、索引、封裝、MCP stdio 與來源保持原樣，不改全域設定、不連控台；通過僅代表這些本機工具檢查成功。

真實場次、索引與報告留在使用者選定的本機位置。Repository 內可用已忽略的 `local-sessions/` 與 `outputs/`；公開工具修改時不要順帶加入真實來源或報告。分享去識別化測試資料應依使用者指定的分享範圍處理，不能只刪 creator 名稱便認為所有私人資料已移除。

## 報告解讀

每份結果用來源 SHA-256 和 JSON Pointer 支持結論，並交代 parser 支援程度、未解析路由和未提供欄位。報告 schema 與工具版本不同：`wing-session-report.v1`／`wing-session-comparison.v1` 是資料結構版本，不代表控台韌體版本。

報告可比較保存的 EQ／動態值、已辨識送出與靜音配置；不從這些值推算房間回授頻點、最佳 EQ、實際聲音或已生效召回。場地用途與預期路由尚未提供時，保留待核對事項，不替使用者補成錯誤判決。
