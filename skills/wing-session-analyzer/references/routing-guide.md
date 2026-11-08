# 正向路由與輸出反查

## 選擇查詢起點

從處理通道找目的地，用 `routes`；從某個已保存的輸出 patch 找來源，用 `output-routes`：

```sh
node '<skill-dir>/scripts/wing-session.mjs' routes '/sessions/show.snap' --kind ch --number 2 --max-depth 8
node '<skill-dir>/scripts/wing-session.mjs' output-routes '/sessions/show.snap' --bank LCL --number 1 --max-depth 8
node '<skill-dir>/scripts/wing-session.mjs' output-routes '/sessions/show.snap' --bank USB --number 48 --max-depth 4
```

`<skill-dir>` 是已安裝的 skill 目錄。`--bank` 是 `/ae_data/io/out` 裡的原始 key，例如 `LCL`、`AUX`、`A`／`B`／`C`、`SC`、`USB`、`CRD`、`MOD`、`REC`、`AES`；使用文件實際存在的 bank 和槽位。不能依 creator 型號或預期硬體數量自行補出輸出。

對應 MCP 是 `wing_routes` 與 `wing_output_routes`，後者參數為 `path`、`bank`、`number`、選用 `maxDepth`。兩種路由查詢都不接受分頁、prefix 或 Markdown 格式；需要較小結果時降低深度或另查確切 Pointer。

## 讀取圖形結果

- `direction: downstream` 從 strip 追向下游；`upstream` 從輸出反查。無論查詢方向，`edges` 都維持**來源 → 目的地**。
- `outputs` 是這次圖中包含的輸出 patch 節點，不是全機端口清單。節點有 bank、槽位、來源 Pointer 及解碼狀態；`output_patch` 邊保留原始 selector 與解碼後來源側別。
- `coverage.outputPatches` 的統計範圍為整份文件。其數量不代表這次起點能到達每一個輸出，亦不表示所有來源都已解碼。
- `maxDepth` 是邏輯 strip 間的跳數，範圍 0–32。終端輸出 patch／User Signal 邊不消耗 strip 跳數，因此深度 0 仍可顯示起點的直接輸出。遇到 `MAX_DEPTH_REACHED` 時交代未繼續展開的關係。
- 主／備來源的候選邊可同時顯示。只有檔案明確給出 `selected=true` 的來源依賴會被繼續追蹤；`false` 或 `null` 不可描述成確定選用的來源。`contextOnly` 節點只提供候選背景，不能當成已遍歷的路徑。
- 缺失的 strip／來源 metadata 可以保留成參照節點與未解析項目。這表示文件沒有包含其狀態，不等於接線錯誤或實體訊號不存在。

回答時引用使用者這份文件的 SHA-256 及路由 Pointer。先說保存的關係，再說 `unresolved`、版本／模型覆蓋和深度界線；不要把一個成功回應改寫成整條路徑已有聲音。

## 已驗證的來源編碼

來源 selector 解碼限定於 `snapshot.11`。輸出 patch 與 User Signal assignment 依 WING Edit 3.3.4 離線 UI 選擇、原生 SAVE 及相鄰檔案對照建立；來源群組表與共用編碼另有 native 靜態對照。未辨識的版本、群組、索引或不完整 assignment 會保留原值和未解析狀態。

### BUS／MAIN／MTX 的左右交錯索引

`io/out/<bank>/<slot>` 的 `{grp,in}` 使用這套編碼：

| `grp` | 已建立的 `in` 範圍 | 邏輯來源 |
| --- | --- | --- |
| `BUS` | 1–32 | BUS 1–16 |
| `MAIN` | 1–8 | MAIN 1–4 |
| `MTX` | 1–16 | MTX 1–8 |

邏輯編號是 `ceil(in / 2)`；奇數是 L，偶數是 R。例如 `BUS,in=3` 是 BUS 2L，`MAIN,in=4` 是 MAIN 2R。輸出邊的側別只說明 patch 選到哪一側，不能推算途中每一級的聲像、寬度、加總或 stereo DSP。

通道主／備輸入使用相同來源群組時，也依共用來源編碼解讀。這一輸入分支有 native 靜態對照，尚未單獨完成與輸出相同的 UI／SAVE 實驗；回答時保留這個證據差異。

### USR 1–24 的 Direct Out

處理後 CH／AUX／BUS／MAIN／MTX 的 User Signal 來源保存於 `/ae_data/io/in/USR/N/user`。這裡的 `in` 是**邏輯 strip 編號**，與上面的左右交錯索引不同；左右／加總由 `lr` 獨立保存。

| `user.grp` | 邏輯 `user.in` 範圍 |
| --- | --- |
| `CH` | 1–40 |
| `AUX` | 1–8 |
| `BUS` | 1–16 |
| `MAIN` | 1–4 |
| `MTX` | 1–8 |

`lr` 可為 `L+R`、`L`、`R`。`tap=PRE` 在 CH／AUX 的介面標示 **TAP**，BUS／MAIN／MTX 則標示 **PRE**；`POST` 是另一個保存的選項。不要把所有 PRE 寫成 pre-fader。CH／AUX 的 TAP 還要連同該 strip 的 `ptap` 看待；未建立的 tap token 或處理順序保持未知。

相同字串也可能有不同的命名空間：通用 selector 的 `grp=AUX` 是原始 AUX 輸入參照，USR 的 `user.grp=AUX` 才是處理後 AUX channel。依完整 Pointer 與 selector 類型解讀，不只比對群組字串。

輸出 `{grp:"USR",in:1}` 選的是 USR 1，不是 USR 的左右側。可能的保存路徑為 `CH 2 → USR 1 → LCL output 1`；這不證明通道未靜音或 Tap 點實際有訊號。

### USR 25–56 的原始輸入 patch

這些 USR 槽位的 `user` 保存原始輸入群組及其槽位，例如 `{grp:"A",in:48}`；不套用處理後 strip 的編號公式，也不補出 `tap`／`lr`。USR 25 的 AES50 A 48 選擇已有原生 SAVE 對照，其餘同形的群組與範圍依已檢視的來源表／實際文件解讀。輸出選擇 `USR,in=25` 時，先到 USR 25，再沿這個原始來源參照追蹤。

這是輸入 patch 的重排，不是某個同名或使用同一輸入的處理通道 Direct Out。是否為可用的實體端口、是否有接線或訊號，仍無法由檔案證明。

### 原始來源直通與 Matrix Direct Input

原始輸入直接 patch 至輸出時，路徑是 `input reference → output patch`。即使某個處理通道也選了相同輸入，這個直通輸出仍不能算成該通道的下游。

`/ae_data/mtx/N/dir` 是 Matrix **Direct Input**，與 USR 的通道 **Direct Out** 分開。已辨識的具名 token `AES`、`MON.PH`、`MON.SPK`、`MON.BUS` 只建立具名 direct-input 參照，不進一步展開 AES／monitor 的內部路徑。`SEND`、`MON` 等未建立的通用來源編碼也不套用 BUS 索引公式。

## 實驗證據與重現界線

公開的[控制實驗摘錄](https://github.com/Mountain-P/wing-session-analyzer/blob/main/docs/routing-experiments.json)保留操作描述、原始參數、Pointer 和原生保存檔的 hash。它是合成測試場次的最小摘錄，沒有附完整原廠 snapshot、安裝包或客戶場次。

本輪證據只將成功原生保存的輸出／USR 對照列為 SAVE 佐證。未完成保存的 USB 指派，以及僅載入或顯示的通道 BUS 輸入，不當成已完成 roundtrip 的案例；靜態編碼對照與成功保存的觀察分開列示。

重現時使用離線 WING Edit 3.3.4：先 SAVE 基準場次，在 Routing 選一個輸出／User Signal，單次改變來源、側別或 tap 後另存；比較相鄰檔案中對應 Pointer，保留兩份檔案的 SHA-256。來源群組切換與選定來源槽位要分開觀察，不能只因 UI 瀏覽了某群組就認定 patch 已改變。

原生 SAVE 證實的是該版本編輯器實際保存的設定。圖形仍不模擬有效靜音、DCA／mute-group、插入效果、tap 順序、scope／safe、召回、目前接線或聲學輸出。`audibleOutput` 維持 `not_determined`。
