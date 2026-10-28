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
| **診斷輸出單一出口與預設安全**(`opt.logDetail`、`opt.funLog`) | **已套(2026-10-28,level-run01)** | **R-DIAG-01** | **`unit-diaglog`、`api-diaglog`** |
| 其餘基本操作(insert/insertBulk/save/del/delAll/select/selectByPk/close、快取、併發、關閉終態、autoGenPk) | 已套 | —(各 `unit-*` 測試) | `unit-basic`、`unit-insert`、`unit-insertbulk`、`unit-save`、`unit-del`、`unit-cache`、`unit-concurrency`、`unit-closed`、`unit-autogenpk`、`unit-returnlist` |

## R-DIAG-01 現況(level-run01)

- 實作: `src/getDiag.mjs`(新)+ `src/WOrmLevel.mjs`(`diag` 建於建構時、`emitChange`/`emitError` 之 catch 改走 `diag(..., true)`、JSDoc 新增 `opt.logDetail`/`opt.funLog`).
- 預設輸出: `change handler threw { mode, errType, errCode? }` / `error handler threw { … }`;`logDetail:true` 還原 `console.log(拋出值)`(遮罩拷貝);`funLog(label, safe, detail)` 取代 console,`detail` 為遮罩拷貝(非原參照).
- 資料庫位置(`opt.url/db/cl` 組成之儲存位址及其絕對路徑、正反斜線形式)視同連線字串: 預設輸出不含細節,`logDetail`/`funLog` 之細節中出現者(如後端 I/O 錯誤文字經訂閱函數轉拋)以 `***` 取代.
- `util.types` 於執行期由 `process.getBuiltinModule('util')` 取得(不靜態 import,UMD 打包相容);取不到時退回 `instanceof` 判定.
- 修前實際輸出站點 2(皆已改)、已註解 7、驅動與相依 0.
- 外審: Argon(`gemini-4-argon-high`)一輪,9 條全數處置(見帳本);terra 額度用盡.
- 文件: README〈診斷輸出〉與〈Breaking changes〉一條;JSDoc.
- 版號/發布: 由主控與使用者處理(本輪未動 `package.json` 之 `version`,未 commit).

## 已知缺口與待辦

1. 各操作 reject/`err`/`error` 事件內之訊息文字(如 `can not insertBulk by existed id[<id>]` 回顯 id、後端 I/O 錯誤原文含位址)屬回傳契約,未動;若要去回顯須另案裁示(破壞性).
2. 取不到 `util.types`(非 Node 或舊版 Node)時無法偵測 Proxy、跨 realm Error 列為 `object`(R-DIAG-01 已知限制);`errCode` 白名單不能排除 `code: 'ERIC'` 這類純大寫字母字串.
3. 遮罩只涵蓋 `opt.url/db/cl` 之位置字串形式;`logDetail` 輸出之子類別 Error 標頭不含類別名(`X [Error]: m` → `Error: m`).
4. 選項型別錯誤採忽略(本套件慣例),w-serv-orm 則 throw(已知差異).
5. 無 e2e(純函式庫);測試鎖用 `quiet-run --lock`.

## 最近一次驗證

- 2026-10-28 level-run01(凍結碼): 全套 `npm test` **3891 passing / 210 pending / 0 failing**(7m42s,exit 0;210 pending 為既有之 GridFS 案);診斷兩檔 75 案綠(單檔約 22 秒);變異 72/72 殺死(基準 75/75 綠;全套之後僅 `test/unit-diaglog.test.mjs` 補 2 處深層繼承斷言,診斷兩檔重跑 75 綠);修前紅 75 案中 28 紅;`npx eslint` 0 error;rollup 打包(`./tmp/level-run01/dist`,不動 `./dist`)後 UMD 實跑預設輸出、logDetail 遮罩、Proxy 偵測皆符.
