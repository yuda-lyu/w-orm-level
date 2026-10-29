# 狀態(現況)

> 只記現況,不寫過程(過程見 `../exp/experience.md`);規則細節見 `../rule/rulebook.md`.接續工作先讀本檔.

## 功能現況

| 功能 | 狀態 | 規則帳本 | 測試檔 |
|---|---|---|---|
| 條件(find)白名單與轉譯(`select`/`delAll`) | 已套 | R-FIND-01、R-FIND-02 | `unit-find-whitelist`、`unit-selectbypk`、`unit-delall` |
| 寫入數據之 Date 範圍檢核 | 已套 | R-DATE-01 | `unit-date-write` |
| 寫入入口前置處理移入 `try`(error 事件恰一次 → reject) | 已套 | R-WRITE-ERR-01 | `unit-write-pre-error`、`unit-event` |
| 字串良構(主鍵、寫入資料、`opt.url/db/cl`) | 已套 | R-ORMSTR-01 | `unit-wellformed` |
| 主鍵存在性以 `Map` 判定 | 已套 | R-PKMAP-01 | `unit-protokey` |
| **診斷輸出與遮罩**(`opt.logDetail`、`opt.funLog`;對外錯誤值遮憑證) | **已套(2026-10-29,mig-level:改用 wsemi 共用實作)** | **R-DIAG-01**(依 dspec〈診斷輸出與遮罩〉) | **`unit-diaglog`、`api-diagwire`、`api-diaglog`** |
| 其餘基本操作(insert/insertBulk/save/del/delAll/select/selectByPk/close、快取、併發、關閉終態、autoGenPk) | 已套 | —(各 `unit-*` 測試) | `unit-basic`、`unit-insert`、`unit-insertbulk`、`unit-save`、`unit-del`、`unit-cache`、`unit-concurrency`、`unit-closed`、`unit-autogenpk`、`unit-returnlist` |

## R-DIAG-01 現況(mig-level)

- 實作: 遮罩、摘要、出口全用 wsemi ≥ 1.9.31 之 `getDiag`/`getDiagSecrets`(`src/getDiag.mjs` 已刪,D1 單一實作);本套件只有宣告與接線: `src/getStoragePaths.mjs`(`paths` 來源:儲存位址與 url,原樣+cwd 絕對路徑)與 `src/WOrmLevel.mjs`(`getDiag(opt, { secrets: getDiagSecrets({ paths }), codes: ['level'], safeKeys: ['mode'] })`、`mkOwnErr`/`outErr`/`outMsg`).
- 預設輸出: `change handler threw { mode, errType, errCode? }` / `error handler threw { … }`(`console.log`,stdout);`logDetail:true` 輸出 `console.log(標籤, 細節)`(遮罩拷貝);`funLog(label, safe, detail)` 取代 console,`detail` 為遮罩拷貝.
- 儲存位址視同連線字串: 診斷輸出(細節)遮為 `***`;**對外錯誤值不遮路徑**(Q3).
- 對外錯誤值遮憑證(新): 外來值(後端、使用端存取器/回呼拋出者)之 reject、'error' 事件、逐筆 `err` 含憑證者以 `***` 取代(同類別副本),不含者原物件;帶自有存取器/可偵測 Proxy 者交遮罩副本(fail-closed);套件自身固定詞彙訊息不遮.站點全集 × 處置見帳本 R-DIAG-01.
- 回傳契約: `diagGolden.json` 0 改變(未重產).
- 文件: README〈診斷輸出〉(含〈對外錯誤值不含憑證〉)與〈Breaking changes〉兩條;JSDoc.
- 版號/發布: 由主控與使用者處理(本輪未動 `package.json` 之 `version`,未 commit).

## 已知缺口與待辦

1. 固定詞彙訊息回顯呼叫端輸入(如 `can not insertBulk by existed id[<id>]`、`invalid find: unsupported column name [<欄名>]`、`invalid data: .. at [data[0].<鍵名>]`)屬回傳契約,不遮;若要去回顯須另案裁示(破壞性).
2. 外來值帶自有存取器/可偵測 Proxy 者,reject 與 'error' 事件交遮罩副本(R-WRITE-ERR-01 規則 1「reject 為拋出者本身」之例外,`unit-write-pre-error` 該案期望已改):待主控確認此契約變化.
3. 本套件無憑證來源,對外遮罩只靠 wsemi 之通用規則(網址帳密、`password=`/`token=` 鍵值對、Bearer);reject 清單為空,短密碼等 wsemi 已知限制不適用.
4. 取不到 `util.types`(非 Node 或舊版 Node)時無法偵測 Proxy(wsemi 已知限制);未宣告 `types`,自訂錯誤子類別之 `errType` 為 `Error`.
5. Level 建構期之 `diag.err` 站點無法由外部觸發(儲存位址恆為非空字串),僅原始碼盤點鎖定;LevelDB 原生層若直接寫 stderr 不在 JS 層可攔範圍.
6. 選項型別錯誤採忽略(本套件慣例),w-serv-orm 則 throw(已知差異).
7. 無 e2e(純函式庫);測試鎖用 `quiet-run --lock`.

## 最近一次驗證

- 2026-10-29 mig-level(凍結碼): 全套 `npm test` **3921 passing / 210 pending / 0 failing**(約 8 分,exit 0;210 pending 為既有之 GridFS 案);診斷三檔 105 案綠(約 35 秒);修前紅(新測試對 git HEAD 之 src)4 檔 241 案中紅 46;變異 23/23 殺死(基準 105/105 綠);`npx eslint`(專案設定)0 error;rollup 打包(`./tmp/mig-level/dist`,不動 `./dist`)後 UMD 實跑預設輸出與 reject 遮罩皆符.
