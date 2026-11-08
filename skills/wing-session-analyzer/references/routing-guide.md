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
- 標準 `report` 將完整共用的路由覆蓋與全文件 output patch 統計放在 `sections.routing`；各通道 `routes.coverage.reportPointer` 指向 `/sections/routing`。單一通道的 `routes.outputs` 總數仍只計該通道在深度內追到的輸出，不能與全文件統計混用。
- `maxDepth` 是邏輯 strip 間的跳數，範圍 0–32。輸出 patch／User Signal／FX send／monitor 等虛擬連接不增加 strip 跳數，因此深度 0 仍可顯示起點的直接輸出；經過它們進入下一個邏輯 strip 時才增加跳數。遇到 `MAX_DEPTH_REACHED` 時交代未繼續展開的關係，邊界的 edge 終點可能不在已展開的 `nodes`。
- 主／備來源的候選邊可同時顯示。只有檔案明確給出 `selected=true` 的來源依賴會被繼續追蹤；`false` 或 `null` 不可描述成確定選用的來源。`contextOnly` 節點只提供候選背景，不能當成已遍歷的路徑。
- 缺失的 strip／來源 metadata 可以保留成參照節點與未解析項目。這表示文件沒有包含其狀態，不等於接線錯誤或實體訊號不存在。
- `fx_send_candidate` 的 `traversed=false` 表示未確定的 insert owner；其背景節點不能當成確定的路徑。MON 的 `monitor_source`／`monitor_direct_input` 則是可追蹤的**保存依賴**，即使 `runtimeSelected` 尚未確定，也不能將兩者改寫成當前實際訊號或多來源加總。

回答時引用使用者這份文件的 SHA-256 及路由 Pointer。先說保存的關係，再說 `unresolved`、版本／模型覆蓋和深度界線；不要把一個成功回應改寫成整條路徑已有聲音。

## 已驗證的來源編碼

來源 selector 解碼限定於 `snapshot.11`。輸出 patch 與 User Signal assignment 依 WING Edit 3.3.4 離線 UI 選擇、原生 SAVE 及相鄰檔案對照建立；來源群組表與共用編碼另有 native 靜態對照。未辨識的版本、群組、索引或不完整 assignment 會保留原值和未解析狀態。

### 通用 selector 的左右交錯索引

`io/out/<bank>/<slot>` 的 `{grp,in}` 使用這套編碼：

| `grp` | 已建立的 `in` 範圍 | 邏輯來源 |
| --- | --- | --- |
| `BUS` | 1–32 | BUS 1–16 |
| `MAIN` | 1–8 | MAIN 1–4 |
| `MTX` | 1–16 | MTX 1–8 |
| `SEND` | 1–32 | FX SEND 1–16 |
| `MON` | 1–4 | 1：PHONES，2：SPEAKERS |

邏輯編號是 `ceil(in / 2)`；奇數是 L，偶數是 R。例如 `BUS,in=3` 是 BUS 2L，`MAIN,in=4` 是 MAIN 2R。輸出邊的側別只說明 patch 選到哪一側，不能推算途中每一級的聲像、寬度、加總或 stereo DSP。

通道主／備輸入的 BUS／MAIN／MTX 也依共用來源編碼解讀。這一輸入分支有 native 靜態對照，尚未單獨完成與輸出相同的 UI／SAVE 實驗；回答時保留這個證據差異。通道輸入 enum 不含 SEND／MON，不能因一般輸出可選它們，就將它們套到通道輸入；工具回報 `unsupported_group_for_consumer`。USR 原始 patch 的群組限制也保持獨立。

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

### SEND 與保存的 insert owner

`SEND` 是 **FX SEND**，代表送往 FX insert 的來源，與通道的 `send/K` 以及處理後的 FX return 不同。通用 selector `{grp:"SEND",in:3}` 是 FX SEND 2L；圖中使用 `fx_send:2` 節點，參照 `/ae_data/fx/2` 的模型與 mix 資料，不補造 `/ae_data/io/in/SEND/3`。

保存的 FX 指派來自 strip 的 `preins.ins`／`postins.ins`，已建立 token 為 `NONE`、`FX1`–`FX16`。CH、BUS、MAIN、MTX 有 pre／post insert；AUX 僅建立 pre insert。CH postins 另外有 `mode=FX/AUTO_X/AUTO_Y`：只有明確的 FX 模式可作為已建立的 FX send owner，automix 不當成 FX 指派。原生實驗將 CH 2 POST 從 FX 切至 AUTO-X 後，SAVE 記錄 `mode="AUTO_X"`、`ins="NONE"`、`on=false`，FX 1 槽改顯示 CH 1 PRE；AUTO-Y 尚無同等控制實驗。

只有一個合格的保存 assignment 時，`fx_send` 邊將它連到對應 send 節點，保留 insert Pointer、原值、位置與 `insertEnabled`。`on` 是另外保存的 bypass 控制；它不抹除 assignment，也不能推導 bypass 時的 DSP send／return 行為。看到 model `NONE`、mix 或開關時，先報保存值，不自行補出處理後的返回路徑。

多個 insert 同時聲稱同一個 FX 時，原生程式有 owner 仲裁；本工具不模擬此仲裁，也不將候選加總。`FX_SEND_OWNER_AMBIGUOUS` 與 `fx_send_candidate` 保留衝突，候選邊 `traversed=false`，不沿它們繼續當成確定路徑。缺少 owner 的 `FX_SEND_OWNER_NOT_IN_DOCUMENT` 也不等於該 FX 在現場未指派，因為部分文件可能省略其他 strips。Owner 唯一性的範圍只限這份文件實際記錄的 assignments。

WING Edit 3.3.4 的後續原生實驗區分兩種操作：在 HOME 的 PRE／POST INSERT → **FX PROCESSOR** 選取已占用的 FX 時，介面詢問 `FX PROCESSOR IN USE! WOULD YOU LIKE TO REASSIGN IT?`，並列出將移除的舊 owner。Cancel 的保存檔（03）與操作前的單一指派狀態（02）逐位元相同；Confirm 將舊 CH 1 PRE 的 `ins` 清為 `NONE`、保留其 `on=true`，再指派給原為 off 的 CH 2 POST。**FX TYPE** 選的是模型，與 processor assignment 分開。

載入預先建立的重複 assignment，則可同時保留兩個聲稱並原生 SAVE；FX 槽的 owner 標示只顯示其中一個。已測 CH 1 PRE on／CH 2 POST off 的 owner 是 CH 2 POST，清除它後 CH 1 PRE 重新成為 owner，保存結果與原單一 assignment 基準相同。反轉整個 CH 物件的 key 順序再次載入，仍顯示 CH 2 POST，原生 SAVE 與原重複案例逐位元相同。CH 1 PRE off／CH 1 POST on 的 owner 是 PRE。因此 `on` 不是這些樣本的 owner 優先條件，也不能由 owner 標示推定有聲音。

跨族群樣本另觀察到 BUS 1 POST 優於 CH 1 PRE、AUX 1 PRE 優於 CH 40 POST、BUS 2 PRE 優於 AUX 8 PRE、MAIN 1 PRE 優於 BUS 16 POST，以及 MTX 1 PRE 優於 MAIN 4 POST。這些樣本佐證靜態掃描的部分優先序，沒有完整覆蓋所有 strip、位置、模型與版本。實驗中的 FX 模型全為 `NONE`；FX 槽 owner 標示是編輯器載入後的衍生狀態，本輪 SAVE 未序列化 `$a_chn`、`$a_pos` 或 insert `$stat`。不能只憑稀疏文件的 key 順序、開關或單一聲稱，推定完整原生執行狀態。

### MON 與保存的監聽來源

通用 selector 的 `MON,in=1/2` 是 **PHONES L/R**，`MON,in=3/4` 是 **SPEAKERS L/R**。圖中的 `monitor:1`／`monitor:2` 參照 `/ae_data/cfg/mon/1`／`2`，不將它們當作原始實體輸入或編號 BUS。

Monitor 會展開兩種保存的依賴，token 的編號都是邏輯 strip 編號：

| 欄位 | 已建立的 token | 邊的種類 |
| --- | --- | --- |
| `src` | `OFF`、`MAIN.1`–`.4`、`MTX.1`–`.8`、`BUS.1`–`.16`、`AUX.1`–`.8` | `monitor_source` |
| `dirin` | `OFF`、`CH.1`–`.40`，以及上列 AUX／BUS／MAIN／MTX 範圍 | `monitor_direct_input` |

例如 `src="BUS.16"` 是處理後的 BUS 16，不是交錯側別 index 16，也不是原始輸入 bank。`AUX.N` 在這裡是處理後的 AUX channel。未知 token、超範圍或缺漏 selector 保留未解析狀態，不補預設值；`OFF` 才是該 selector 的斷開 token。

`src` 與 `dirin` 不表示單一、排他的即時來源。節點保留 `srclvl`、`srcmix`、`lvl`，以及 `/ae_data/cfg/solo` 的模式、監聽選擇與 tap 等設定背景；`srcmix=-144` 不能單獨證明 regular source 已關閉。Live solo／PFL／SIP、mute、dim、talkback 及來源混合仍未確定，因此 `MONITOR_RUNTIME_STATE_UNKNOWN` 是必要的界線，不能為了看起來「完整」而略去。

### 適用範圍與覆蓋狀態

`coverage.fxSendSources` 描述已建立的 FX send selector 與保存 owner；`monitorSources` 描述已建立的 selector 與保存依賴，保留 runtime unknown。它們不證明每個 bank／slot／model 都做過 UI 實測，成功原生 SAVE 的具體案例與靜態對照分別列在公開實驗摘錄。非 `snapshot.11` 一律不套用這些來源 codec。

### 原始來源直通與 Matrix Direct Input

原始輸入直接 patch 至輸出時，路徑是 `input reference → output patch`。即使某個處理通道也選了相同輸入，這個直通輸出仍不能算成該通道的下游。

`/ae_data/mtx/N/dir` 是 Matrix **Direct Input**，與 USR 的通道 **Direct Out** 分開。啟用的 `MON.PH`／`MON.SPK` 依賴分別連到 PHONES／SPEAKERS 的 monitor 設定節點；其上游仍受監聽的即時界線限制。`AES` 保留具名參照，不補出某個實體 AES 輸入。`MON.BUS` 是另一個內部 monitor／solo bus，保留 `MONITOR_BUS_RUNTIME_STATE_UNKNOWN`，不將它別名成 PHONES、SPEAKERS 或普通 BUS。

## 實驗證據與重現界線

公開的[首輪路由實驗](https://github.com/Mountain-P/wing-session-analyzer/blob/main/docs/routing-experiments.json)、[SEND／MON 實驗](https://github.com/Mountain-P/wing-session-analyzer/blob/main/docs/send-mon-experiments.json)與後續 [FX owner 實驗](https://github.com/Mountain-P/wing-session-analyzer/blob/main/docs/fx-owner-experiments.json)保留操作描述、原始參數、Pointer 和原生保存檔的 hash。它們是合成測試場次的最小摘錄，沒有附完整原廠 snapshot、安裝包或客戶場次。

SEND／MON 這輪取得 9 份原生保存檔，含基準與 8 個控制變體：SEND 的保存 index 為 1、2、3、31、32；MON 輸出成功保存的是 index 1（PHONES L），監聽設定另成功保存 `src="BUS.16"` 與 `dirin="CH.40"`。其餘 MON 來源卡片的 PHONES 1L／1R、SPEAKERS 2L／2R 標示有 UI 觀察與靜態對照，未取得各 index 的獨立原生 SAVE；不得稱為四個輸出 index 全部完成回存實驗。

前一輪 SEND／MON 實驗當時對 FX insert owner、bypass、automix 與重複 owner 仲裁只有 native 靜態佐證；其 ledger 保留當時的覆蓋範圍。後續 FX owner 實驗取得 11 份原生保存檔（含基準），涵蓋 7 組不同的重複指派及一次 CH key 反序重測，另補上 GUI 重新指派的 Confirm／Cancel、on／off 與 AUTO-X 切換。這些是 Mac WING Edit 3.3.4 的離線觀察，不是實體控台、FX 音訊或聲學測試；個別成功的 owner 樣本也不涵蓋所有 automix 與 FX 模型行為。

只有成功原生保存的對照列為 SAVE 佐證。首輪未完成保存的 USB 指派，以及僅載入或顯示的通道 BUS 輸入，不當成已完成 roundtrip 的案例；靜態編碼對照與成功保存的觀察分開列示。SEND 的每個 owner 模式／衝突，以及 MON 的每個 token／即時狀態，不因來源 index 已驗證便自動宣稱全部實測。

重現時使用離線 WING Edit 3.3.4：先 SAVE 基準場次，在 Routing 選一個輸出／User Signal，單次改變來源、側別或 tap 後另存；比較相鄰檔案中對應 Pointer，保留兩份檔案的 SHA-256。來源群組切換與選定來源槽位要分開觀察，不能只因 UI 瀏覽了某群組就認定 patch 已改變。

原生 SAVE 證實的是該版本編輯器實際保存的設定。圖形仍不模擬有效靜音、DCA／mute-group、插入效果、tap 順序、scope／safe、召回、目前接線或聲學輸出。`audibleOutput` 維持 `not_determined`。
