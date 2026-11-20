# 狀態(現況)

> 只記現況,不寫過程(過程見 `../exp/experience.md`);規則細節見 `../rule/rulebook.md`.接續工作先讀本檔.

- 語料 wire 案處置(2026-11-01,orm233): `api-diagwire` 之「wire案歸類全集」對 wsemi 1.9.36 語料 wire 案 23 個全數歸類(DETAIL 9、BRIEF 1、REJECT 2〔T07 與 DETAIL 重疊〕、NA 12);新增之 A11(`genDiagFunLog` 之 `opt.safeKeys`)、C14(`getDiagBriefErr` 之 `types`)、U22(`getDiagSecrets` 之 `conns`)皆判不適用: `src/WOrmLevel.mjs` 只引入 `getDiag`(:23)與 `getDiagSecrets`(:24),兩者不引入 `genDiagFunLog`;宣告為 `paths`(`getStoragePaths`)、`codes:['level']`、`safeKeys:['mode']`(:154-157),無 `types`、`conns`.
- 最近一次全套驗證(2026-11-20,oro557b2〔第 557 項對齊輪〕,wsemi 1.9.70): `npm test`(`quiet-run --lock`)**4725 passing / 210 pending / 0 failing**(8 分 45 秒,exit 0;210 pending 為既有之 GridFS 案);修前紅(最終測試對修前 `src`)6 檔 1008 案中紅 398;變異新增 33/33 + 既有 R1 9/9、R2 13/14(R2-14 僅原始碼文字鎖定案可殺);`npx eslint` 改動檔 0 error;private-guard CLEAN.
- 前一次全套驗證(2026-11-20,oro557b,wsemi 1.9.70): 4498 passing / 210 pending / 0 failing(8 分 25 秒).
- 再前一次(2026-11-19,olv492i,wsemi 1.9.69): 4056 passing / 210 pending / 0 failing.

## 功能現況

| 功能 | 狀態 | 規則帳本 | 測試檔 |
|---|---|---|---|
| 條件(find)白名單與轉譯(`select`/`delAll`) | 已套 | R-FIND-01、R-FIND-02 | `unit-find-whitelist`、`unit-selectbypk`、`unit-delall` |
| 寫入數據之 Date 範圍檢核 | 已套 | R-DATE-01 | `unit-date-write` |
| 寫入入口前置處理移入 `try`(error 事件恰一次 → reject) | 已套 | R-WRITE-ERR-01 | `unit-write-pre-error`、`unit-event` |
| **呼叫端給的值之可讀性**(wsemi ≥ 1.9.69 判斷函數回布林後,不可讀之 `data`、`option.returnList`、經原型存取器讀出之 `id`、`selectByPk` 之 `pk`、建構 `opt` 仍走原失敗通道;**2026-11-20 起改用 wsemi `chkReadable`,訊息為固定詞彙 `invalid <名稱>: must be a readable value`**) | **已套(2026-11-19 olv492i 本地探針;2026-11-20 oro557b 改 `chkReadable`)** | **R-PROBE-01**(15 站〔S01~S15,oro557b2 增 S13~S15〕;與 R-WRITE-ERR-01 規則 1 銜接) | **`unit-probe-readable`、`unit-write-pre-error`**(敵意值建構器 `test/lib/hostile.mjs`) |
| **主鍵(id)之「未帶」與「給了而非字串」**(未帶只有 `undefined`/`null`/`''`;給了而非字串者拒絕、不替換為新主鍵,通道不隨 `autoGenPk` 改變) | **已套(2026-11-20,oro557b)** | **R-PKGIVEN-01** | **`unit-pk-given`**、`unit-wellformed`、`unit-autogenpk` |
| **全族對齊口徑 A1~A6**(選項容器不可讀 → `invalid opt`/`invalid option`;存取器拋錯與複製階段之巢狀不可讀值 → 固定詞彙、不轉出拋出者之文字;入口階段拒絕之 `error` 事件 `data` 為 `null`;`selectByPk` 不可讀 `pk` reject;主鍵給了而無效) | **已套(2026-11-20,oro557b2)** | **R-ALIGN-01**(A1~A6;與 R-PROBE-01、R-PKGIVEN-01、R-WRITE-ERR-01 銜接) | **`unit-align-readable`**、`unit-probe-readable`、`unit-write-pre-error`、`unit-pk-given` |
| 字串良構(主鍵、寫入資料、`opt.url/db/cl`) | 已套 | R-ORMSTR-01 | `unit-wellformed` |
| 主鍵存在性以 `Map` 判定 | 已套 | R-PKMAP-01 | `unit-protokey` |
| **診斷輸出與遮罩**(`opt.logDetail`、`opt.funLog`;對外錯誤值遮憑證) | **已套(2026-10-29,mig-level:改用 wsemi 共用實作)** | **R-DIAG-01**(依 dspec〈診斷輸出與遮罩〉) | **`unit-diaglog`、`api-diagwire`、`api-diaglog`** |
| 其餘基本操作(insert/insertBulk/save/del/delAll/select/selectByPk/close、快取、併發、關閉終態、autoGenPk) | 已套 | —(各 `unit-*` 測試) | `unit-basic`、`unit-insert`、`unit-insertbulk`、`unit-save`、`unit-del`、`unit-cache`、`unit-concurrency`、`unit-closed`、`unit-autogenpk`、`unit-returnlist` |

## R-DIAG-01 現況(mig-level)

- 實作: 遮罩、摘要、出口全用 wsemi ≥ 1.9.31 之 `getDiag`/`getDiagSecrets`(`src/getDiag.mjs` 已刪,D1 單一實作);本套件診斷面只有宣告與接線(`src/` 只有兩個檔;2026-11-20 起本地 `probeReadable.mjs` 已刪,改用 wsemi `chkReadable`,`unit-diaglog` 之檔案清單改回兩個檔): `src/getStoragePaths.mjs`(`paths` 來源:儲存位址與 url,原樣+cwd 絕對路徑)與 `src/WOrmLevel.mjs`(`getDiag(opt, { secrets: getDiagSecrets({ paths }), codes: ['level'], safeKeys: ['mode'] })`、`mkOwnErr`/`outErr`/`outMsg`).
- 預設輸出: `change handler threw { mode, errType, errCode? }` / `error handler threw { … }`(`console.log`,stdout);`logDetail:true` 輸出 `console.log(標籤, 細節)`(遮罩拷貝);`funLog(label, safe, detail)` 取代 console,`detail` 為遮罩拷貝.
- 儲存位址視同連線字串: 診斷輸出(細節)遮為 `***`;**對外錯誤值不遮路徑**(Q3).
- 對外錯誤值遮憑證(新): 外來值(後端、使用端存取器/回呼拋出者)之 reject、'error' 事件、逐筆 `err` 含憑證者以 `***` 取代(同類別副本),不含者原物件;帶自有存取器/可偵測 Proxy 者交遮罩副本(fail-closed);套件自身固定詞彙訊息不遮.站點全集 × 處置見帳本 R-DIAG-01.
- 回傳契約: `diagGolden.json` 0 改變(未重產).
- 文件: README〈診斷輸出〉(含〈對外錯誤值不含憑證〉)與〈Breaking changes〉兩條;JSDoc.
- 版號/發布: 由主控與使用者處理(本輪未動 `package.json` 之 `version`,未 commit).

## R-PROBE-01 現況(olv492i 建立;oro557b 改用 wsemi `chkReadable`)

- 實作(2026-11-20 起): 無本地探針(`src/probeReadable.mjs` 已刪),於判斷函數回 `false` 之分支內以 wsemi `chkReadable` 分辨「不可讀」與「可讀而型別不符」(有效輸入不探測),接線於 `src/WOrmLevel.mjs` 12 站(建構 `opt.url/db/cl/useCache/autoGenPk` 經 `chkOptReadable`、`selectByPkCore` 之 `pk`、`insertCore` 之 `option.returnList`、`insert`/`insertBulk`/`save`/`del` 之 `data` 經 `chkDataReadable`〔`ownKeys` 僅標籤為 `[object Object]` 者,單元素陣列 `[0]` 存取器由呼叫端自讀〕、`procPk` 之 `id`〔原型存取器〕),站點行號與不適用清單見帳本.不可讀者走各站原失敗通道,訊息為固定詞彙 `invalid <名稱>: must be a readable value`(不含原例外文字;2026-11-20 oro557b2 起 `cloneDeep` 等非判斷函數站點與容器、存取器之讀取拋錯亦轉固定詞彙,見 R-ALIGN-01).站點行號已於 oro557b2 更新(S01~S15).
- 行為: 與 wsemi 1.9.68 時之行為對照,敵意值矩陣①(160 格)僅 9 格不同——3 格已知邊界(僅 `has` 陷阱拋錯之 Proxy 作 `returnList`/`useCache`/`autoGenPk` 不再拒收)、6 格僅訊息文字;矩陣②(71 格)僅 15 格不同,皆為 wsemi 1.9.69 包裝物件語意變更(`id` 已由 R-PKGIVEN-01 拒收,其餘見帳本已知邊界③,待裁示).oro557b 修前修後 320 格入口 × 輸入矩陣之差異見第 557 項報告.
- 測試: `unit-probe-readable`(171 案)、`unit-write-pre-error`(161 案)、`unit-pk-given`(382 案)、`unit-align-readable`(227 案,oro557b2 新);`unit-diaglog` 之 src 檔案清單改回 `WOrmLevel.mjs`、`getStoragePaths.mjs`,`throw` 站點全集計數隨 oro557b2 再更新(`mkOwnErr` 7、`mkInErr` 11、`new Error(` 5、`throw` 27).`api-diagwire` 之外來值注入點改為後端接縫(使用端存取器於複製階段拋出已為固定詞彙).
- 版號/發布: 由主控與使用者處理(本輪未動 `package.json` 之 `version`,未 commit).

## R-PKGIVEN-01 現況(oro557b)

- 實作: `procPk`(`src/WOrmLevel.mjs`)以 `=== undefined/null/''` 判「未帶」(`autoGenPk` 為 true 補值、false 整批 reject,`save` 亦然),其餘為「給了」: 給了而非字串者不補值、不替換,交其後之良構檢核(`chkPk`)拒絕——`insert`/`insertBulk` 整批 reject、`save`/`del` 該筆 `ok:0`、`selectByPk` 回 `null`,訊息 `invalid id: not a string at [data[<k>].id]`,通道不隨 `autoGenPk` 改變.
- 不相容變更: README〈Breaking changes〉兩條、帳本〈破壞性變更紀錄〉.
- 已知邊界(帳本有詳述): 未帶與給了並存且 `autoGenPk` 為 false 時先報未帶;自有屬性之敵意物件主鍵於 `cloneDeep` 即拋錯(2026-11-20 起為固定詞彙 `invalid data: must be a readable value`,非 `not a string`);範圍外 `Date` 之 id 先報 Date.
- 版號/發布: 由主控與使用者處理(本輪未動 `package.json` 之 `version`,未 commit).

## R-ALIGN-01 現況(oro557b2,第 557 項對齊輪)

- 實作(`src/WOrmLevel.mjs`): `getOptVal`(建構 `opt` 容器/成員)、`getOpt`(`option`)、`copyData`(`cloneDeep` 包裝,4 個寫入入口)、`guardRead`(複本之後之讀取: `toJSON`、繼承存取器、`merge`、`del` 之 id)、`mkInErr`/`inErrs`(固定詞彙之本套件錯誤與登記,各 Core 之 `catch` 見之即 `data = null`)、`procPk`(id 讀取與補主鍵指派)、`procClosed`(事件 `data` 之標籤可讀性).
- 口徑: 容器不可讀 → `invalid opt`/`invalid option`;成員存取器拋錯 → `invalid opt.<名>`/`invalid option.<名>`/`invalid data`;複製階段之巢狀不可讀值與過深/null 原型 Date → `invalid data`(不分辨頂層與巢狀);入口階段拒絕之 `error` 事件 `data` 為 `null`;`selectByPk` 不可讀 `pk` reject `invalid pk`;主鍵給了而無效 → `invalid id: not a string`(R-PKGIVEN-01,已合).
- 不相容變更: README〈Breaking changes〉、JSDoc、帳本〈破壞性變更紀錄〉.
- 已知邊界(帳本有詳述): 有狀態之存取器(第 N 次讀才拋錯)於複本之後之重複讀取未包裝;逐筆路徑之 `error` 事件 `data` 為複本;`del` 之原型存取器 `id` 回已撤銷之 Proxy 者仍為該筆 `ok:0`.
- 版號/發布: 由主控與使用者處理(本輪未動 `package.json` 之 `version`,未 commit).

## 已知缺口與待辦

0. R-PROBE-01 已知邊界(帳本有詳述,待裁示者為③):①僅 `has` 陷阱拋錯之 Proxy 作為 `option.returnList`、`opt.useCache`、`opt.autoGenPk` 時視為可讀而型別不符(忽略/預設);②有狀態(只在特定次讀取拋錯)之敵意物件結果依讀取次數;③wsemi 1.9.69 之包裝物件(`new String`/`new Boolean`/`new Number`)語意變更使 `opt.url` 等、`returnList`、`[new String('')]` 之行為改變(後者會寫入空值紀錄),是否於本庫補守或請 wsemi 調整待裁示(`id` 為包裝物件者已由 R-PKGIVEN-01 拒收).
0a. 〔已由主控裁定,2026-11-20 oro557b2 落實〕讀取即拋錯之 `id` 之措辭: 複製階段(自有屬性)與經原型存取器讀出而不可讀者,皆為 `invalid data: must be a readable value`(原失敗通道,`save` 亦整批 reject,`error` 事件 `data` 為 `null`);可讀而非字串者為 `invalid id: not a string`.
1. 固定詞彙訊息回顯呼叫端輸入(如 `can not insertBulk by existed id[<id>]`、`invalid find: unsupported column name [<欄名>]`、`invalid data: .. at [data[0].<鍵名>]`)屬回傳契約,不遮;若要去回顯須另案裁示(破壞性).
2. 外來值帶自有存取器/可偵測 Proxy 者,reject 與 'error' 事件交遮罩副本(R-WRITE-ERR-01 規則 1「reject 為拋出者本身」之例外,`unit-write-pre-error` 該案期望已改):待主控確認此契約變化.
3. 本套件無憑證來源,對外遮罩只靠 wsemi 之通用規則(網址帳密、`password=`/`token=` 鍵值對、Bearer);reject 清單為空,短密碼等 wsemi 已知限制不適用.
4. 取不到 `util.types`(非 Node 或舊版 Node)時無法偵測 Proxy(wsemi 已知限制);未宣告 `types`,自訂錯誤子類別之 `errType` 為 `Error`.
5. Level 建構期之 `diag.err` 站點無法由外部觸發(儲存位址恆為非空字串),僅原始碼盤點鎖定;LevelDB 原生層若直接寫 stderr 不在 JS 層可攔範圍.
6. 選項型別錯誤採忽略(本套件慣例),w-serv-orm 則 throw(已知差異).
7. 無 e2e(純函式庫);測試鎖用 `quiet-run --lock`.

## 最近一次驗證

- 2026-10-29 mig-level(凍結碼): 全套 `npm test` **3921 passing / 210 pending / 0 failing**(約 8 分,exit 0;210 pending 為既有之 GridFS 案);診斷三檔 105 案綠(約 35 秒);修前紅(新測試對 git HEAD 之 src)4 檔 241 案中紅 46;變異 23/23 殺死(基準 105/105 綠);`npx eslint`(專案設定)0 error;rollup 打包(`./tmp/mig-level/dist`,不動 `./dist`)後 UMD 實跑預設輸出與 reject 遮罩皆符.
