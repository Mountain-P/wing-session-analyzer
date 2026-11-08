# 格式與證據界線

## 先看內容，不憑副檔名

輸入必須是工具接受的本地 JSON 文件。識別時同時檢查宣告的 `type` 和資料形狀；把任意文字改名成 `.snap` 不會成為 WING snapshot。有效 JSON 也不等於有效或完整的 WING 場次。

| 用途／常見副檔名 | 已辨識的宣告 | 關鍵資料形狀 | 解讀範圍 |
| --- | --- | --- | --- |
| Snapshot `.snap` | `snapshot.11` | `ae_data`、`ce_data`，可含 `ae_globals`、`ce_globals`、`scopes` | 已建立的 snapshot 結構；稀疏或缺漏內容仍須如實回報 |
| Show `.show` | `showfile.1` | `scenes.count` 與編號 scene 記錄 | 已建立的 show 清單結構；不是全部 scene 合併後的控台狀態 |
| Snippet `.snip` | `snippet.11` | `num_pars`、部分 `ae_data`／`ce_data` 或 globals | 部分參數集合；不能當成完整 snapshot |
| 通道族 preset `.chn`、`.aux`、`.bus`、`.main`、`.mtx` | `chpreset.11` | `source_channel`、`ch_data`，可含 insert、scope、feed 資料 | 單一通道族預設；副檔名不能獨自決定目標種類 |
| FX preset `.fx` | `fxpreset.11` | `source_fx_engine`、`fx_data` | 效果器預設，不是整體混音或完整通道路由 |

`snapshot.11`／`showfile.1` 是本工具主要已建立的格式。其他版本，以及 snippet／preset 的完整召回語意，只做工具明確支援的部分分析；以回傳的支援狀態、warnings 和限制為準，不宣稱已遷移成目前版本。結構不相符或無法辨識時，保留錯誤／未知，不繞過分類器把它當成 snapshot。

不支援 WING-Live SD 卡的多軌音訊 session、錄音音訊內容、未知二進位 session、韌體或安裝包。Show 引用 `.wav` 只表示有這個引用；本工具不解碼音訊或驗證其可播放性。

## Snapshot 參數樹

典型 `ae_data` 區塊含 `cfg`、`io`、`ch`、`aux`、`bus`、`main`、`mtx`、`dca`、`mgrp`、`fx`、cards、play、rec。`ce_data` 可含 cfg、layer、user、GPIO、safes、DAW、MIDI、OSC 與 library。使用文件實際存在的節點，不能依預期最大數量補出通道。

- 節點通常以十進位字串編號，例如 `/ae_data/ch/1`。CLI 的 `--number 1` 是文件中的編號，不是陣列零起始位置。
- 同一語意可能分散在設定、路由和 scope 區塊；先跟隨工具給出的 `sourcePointers`，不要僅靠搜尋到的標籤判斷整個訊號路徑。
- Creator 型號、韌體、序號和時間只描述文件 metadata，不能驗證目前控台、目前接線或目前 firmware。
- `null`、缺少欄位、數字 `0`、字串 `"0"`、布林 `false` 是不同值。工具比較應保留這些差異。

### 常見通道欄位

以下是已觀察到的欄位；只解讀使用者文件實際存在的值，不用它們補齊部分文件。

| 相對於 `/ae_data/ch/N` 的位置 | 解讀方式 |
| --- | --- |
| `name`、`col`、`clink` | `clink=false` 使用通道自訂名稱／顏色；`true` 會跟隨目前來源的 metadata，並不是 stereo-link 開關。原生空名稱的顯示 fallback 尚未完整模擬。 |
| `in/conn/grp`、`in/conn/in` | Primary 來源的群組與序號；alternate 是 `altgrp`、`altin`。`snapshot.11` 的 BUS／MAIN／MTX 序號包含左右側，依路由 codec 解碼，不直接當邏輯 strip 編號。 |
| `in/set/srcauto`、`in/set/altsrc` | `srcauto=false` 且 `altsrc` 明確為布林值時，才可確定檔案選擇 primary／alternate。自動或省略旗標時，實際來源保持未知。 |
| `flt/lc`、`flt/lcf` | 已保存的 high-pass／low-cut 開關與 Hz 值。 |
| `eq/on`、`eq/mdl` | EQ 開關與模型；先看模型，再解讀它的參數，不能把 STD 欄位套到所有模型。 |
| STD EQ 的 `1f`、`1g`、`1q` 等 | 對應段的頻率、dB 增減與 Q；`eq/on=false` 時，仍可能保留參數值。它們不構成整體音色或現場頻率響應的量測。 |
| `mute`、`fdr` | 通道自身靜音與保存的推桿值。`-144` 是已觀察到的最低值；DCA、mute-group、tap 與現場狀態仍可能影響有效結果。 |
| `main/K/on`、`send/K/on` | 已明確啟用的送出；查閱同一節點的 level、pre／mode。不同送出可能是並行分支，不要自動串成一條路徑。 |

其他通道族或動態／效果器模型先呈現原始節點及模型；未建立的參數語義保持未知。`snapshot.11` 的輸出 BUS／MAIN／MTX 來源採左右交錯索引，USR Direct Out 則使用另一套邏輯 strip 編號及獨立 `tap`／`lr`。已驗證的規則、來源直通及 Matrix Direct Input 的界線見 [routing-guide.md](routing-guide.md)；未知版本或編碼仍保留未解析狀態。

## Show 與本地引用

Scene 記錄可含 name、skip、link、type、info、tag、midi_tx、file、targets 與 scope 欄位。`file` 是被引用的檔名／路徑資料；不應作為 shell 片段或指令執行。Scene 的順序與檔名不證明該 scene 實際召回過。

`check_assets`／`assets` 只能在顯式允許的本地範圍核對引用。區分未找到、超出允許根目錄、不可讀、無法在本機映射及非本地引用；不要把這些狀態統一說成檔案損壞。Windows 絕對路徑或控台儲存路徑，可能無法直接映射至目前電腦。

## 可追溯的報告

使用本次來源檔案的 SHA-256 加 JSON Pointer 作為證據。例如「來源 SHA-256 `…`，`/ae_data/ch/1/...` 的值為 `…`」。Pointer 是 RFC 6901 路徑：key 中的 `~` 編碼為 `~0`，`/` 編碼為 `~1`。空字串表示根節點；不是 JavaScript 表達式、JSONPath 或 URL。

不要只引用某個逆向分析位址來證明使用者場次的值，也不要把原廠模板的參數當成使用者檔案裡已存在的內容。輸出包含的本地檔名和任意 metadata 仍可能是私人資料；公開前依使用者要求去識別，不自行改動原始場次。
