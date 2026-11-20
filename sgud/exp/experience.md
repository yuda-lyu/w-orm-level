# 累積經驗

本檔為執行工作時特有之累積經驗,留給後續之嘗試、執行與判斷,由agent自行編列、擴充與維護.

## 條件(find)白名單接線(第 33 項批 1)(2026-10-17)

- 通用經驗(修前紅對帳法、翻轉讀值之 Proxy 測試法、mingo 原型成員欄名缺陷、方案文字進 README 前須對 HEAD 實跑、外審派工法)記於 w-orm-lmdb 之 `sgud/exp/experience.md` 同名一節,此處只記本套件特有者.
- **Date**: 數據以 JSON 存值(`valueEncoding:'json'`),Date 存入後為 `toISOString()` 字串;修正前條件內之 Date 對 `$eq/$gt/$gte/$lt/$lte/$in` 恆不命中、對 `$ne/$nin` 恆命中(`delAll({d:{$ne:Date}})` 對 HEAD 實測刪光 6 筆).現於轉譯層 `isoFind` 把複本內之 Date 轉為 ISO 字串;限制: 以字串字典序比較,與字串型欄位亦會比較,範圍外年份(`new Date(8.64e15)` 哨兵)字典序顛倒(外審 opus F1/F6),已載明於 README,是否 fail-closed 待主控裁示.
- **`close()` 排入 `serialize` 佇列**: 呼叫 `close()` 後 `status` 不會同步變為 closing,同步執行期間(如檢核途中)呼叫它不影響該次呼叫;測「關閉進行中」須先讓出一個 macrotask 再呼叫壞條件.
- **無法解碼紀錄之夾具**: `new Level(路徑, { valueEncoding: 'buffer' })` 對 `<url>/<db>/<cl>` 寫入 `Buffer.from('{ invalid JSON')` 後關閉,再以 WOrmLevel 開啟,任何讀取皆拋 `Iterator could not decode data`.
- **變異腳本**: `tmp/mutate2.mjs`(需環境變數 `WSRC=WOrmLevel.mjs HASCLOSE=1`),搭配 `tmp/runvariant.mjs`、`tmp/classify.mjs`、`tmp/reconcile.mjs`.

## 範圍外 Date 條件 fail-closed(第 67 項,R-FIND-02)(2026-10-19)

- **兩種「哨兵被誤刪」要分開**: 條件側(`delAll({t:{$gt:new Date(8.64e15)}})` 刪光帶日期資料、`$lt` 哨兵恆無命中)可由轉譯層 reject 修掉;**數據側**(資料裡存了 `new Date(8.64e15)`,範圍內條件 `$lt 現在` 命中它)條件檢核修不到,主控裁示不改寫入行為,只能文件載明.交付報告須同時給出兩者修前修後行為,不可讓人以為原始外審場景已消失.
- **路徑格式測試法**: 把待測結構中的 Date 換成 `undefined` 丟給 `cvOrmFind`,其訊息的 `at [路徑]` 即共用檢核對同一結構的路徑,拿來逐字比對本層路徑(含單鍵 > 30 字元截短、全路徑 > 120 截短、截斷處切開代理對).自己手寫期望值易與共用檢核分歧(代理對被 `clean` 換成 `?` 即是自查才發現).
- **年份 0000 的 Date**: `Date.UTC(0, …)` 會被當成 1900 年,年份 0–99 一律以 ISO 字串(`new Date('0000-01-01T00:00:00.000Z')`)建構.
- **拒收案例須傳同一個條件物件再比對**: 測試若每次呼叫都重建條件物件、只檢查另存的變數,看不到「reject 時改寫呼叫端物件」(外審 sol F03,變異 M25 重現).用 `leaves()` 取全節點(參照、毫秒、鍵序)前後比對.
- **接受側也要參數化**: 只測兩個精確端點會放過「只接受端點、誤拒端點內側」之變異(外審 sol F02,變異 M24/M26);以真實時間序(`getTime()` 比較)為期望,而非字串比較.
- **變異腳本 `tmp/mutate-date.mjs`**(帶 `rep()` 錨點必須恰一處,否則拋錯避免變異未套用): 副本置於 `<repo>/tmp/mut/<名>/{src,test}`,靠上層 `node_modules` 解析套件,不用目錄連接點;`DUMP=1` 存各變異輸出.後面的測試若未自行 `resetDr`,會被前面紅掉的測試殘留資料牽連而假紅(M14 delAll 不檢核時多紅 1 案即此),每案自己重置資料.`tmp/run-head.mjs` 以 `git show HEAD:src/…` 取修前版跑最終測試,取得真實修前紅.
- (第 67 項第 2 次執行〔寫入側,R-DATE-01〕之經驗另見下一節.)
- **外審派工**: 兩位審查者各給一份副本(`tmp/review/<審查者>/{level,lowdb}-copy`),共用 `tmp/review/node_modules`(只放 lowdb、steno,其餘由上層 repo 之 `node_modules` 解析).sol(`gpt-6.1-sol`/max,`--json` 讓事件串流可觀察存活)約 10 分鐘完成;beam(`opencode/beam-free`/xhigh)開跑 1 分鐘後在新一步停住 15 分鐘無輸出,以 `taskkill /F /T /PID <node.pid>` 終止(連 opencode 子行程),回驗 PID 已消失.

## 寫入時拒收範圍外 Date(第 67 項第 2 次執行,R-DATE-01)(2026-10-19)

- **檢核對象 = 佇列內 `cloneDeep` 後之複本**: 各 `*Core` 在 `serialize` 佇列執行時才 `cloneDeep(data)`,所以呼叫 `insert(obj)` 之後、同步程式碼內改動 `obj` 的 Date 會被複本看見;若於入口(`insert` 外殼)對呼叫端物件檢核,則「檢查之值 ≠ 實際寫入之值」。測試不要釘死「何時複製」,改寫成不變式: 無論拒收與否,資料庫內不得出現範圍外字串(變異 M14 檢核移到入口即由此轉紅).
- **以 `JSON.stringify(節點)` 判定**: 與 level/lowdb 實際寫入同一序列化,無效 Date 自然為 `null`(不拒收、處置不變)、自有 `toISOString`/`toJSON` 覆寫自然與存入值一致,不必另寫 Date 規則. lodash `cloneDeep` 以 `new Ctor(+date)` 重建 Date 並複製自有可列舉屬性: 自有 `valueOf` 會改變複本之時間值(故 `valueOf` 覆寫案例不納入測試),自有 `toISOString`/`toJSON`/`getTime` 會留在複本上.
- **辨認 Date 的低成本寫法**: 先看 `typeof v.toJSON === 'function'`(JSON.stringify 的觸發條件,不分 Date 與否),再以 `Date.prototype.getTime.call(v)` 證明內部槽; 對每個物件節點都 try/catch 會每次拋錯(約 3µs),大批寫入慢數倍.
- **循環參照不能由檢核報錯**: `save(autoInsert:false)` 命中不到主鍵時不序列化,原本對循環參照 resolve;檢核以祖先堆疊(`anc.includes`)遇回邊略過,維持「寫入時由 JSON 序列化報錯」之既有結果. 兄弟節點仍須檢查(測試: 回邊在前、範圍外 Date 在後).
- **資料之鍵不受條件白名單文法約束**: 路徑要用 JSON 字串括號法(`["a.b"]`)表示非識別字之鍵,孤立代理碼元由 `JSON.stringify` 轉義(Node ≥ 12),不能沿用條件側 `.鍵` 一律點記法.
- **效能**: 走訪約 +3~5µs/筆(每筆 12 節點),`insertBulk` 50000 筆約 +150~250ms(量測 `tmp/bench-write.mjs`,機器忙碌時抖動大); 陣列用索引迴圈、路徑只在拋出時才組(`ks` 鍵序列).
- **修前紅要連 `test/lib` 一起複製**(`tmp/run-head-write.mjs`);變異名稱不可含 `:`(Windows 目錄名).
- **兩套件共用 helper 放 `test/lib`**(`mkObserver.mjs`、`leaves.mjs`),本套件既有慣例(`test/lib/procConcurrency.mjs`),不是 `test/tools`.
- **lodash-es 在 ESM 下 `isBuffer` 恆為 false**(`isBuffer.js` 靠 `module.exports` 判定而 ESM 無): `cloneDeep` 把 Buffer 當 TypedArray 複製,**自有屬性隨之複製**;而 JSON 取 Buffer 的 `toJSON` 輸出、不含自有屬性. 故 `chkDataDate` 對「有 `toJSON` 的 ArrayBuffer 視圖」不走訪是正確性所需(否則 Buffer 上掛的 Date 會被誤拒,變異 M32 驗證),無 `toJSON` 的視圖(TypedArray、DataView)則其自有屬性會被序列化、須走訪(外審 F-01). 這類「複本與原物件不同」的事實必須實跑 `cloneDeep` 確認,不可憑 lodash 文件推論(外審 Argon 與我方對此各錯了一半).
- **走訪用「已走訪集合」不用「祖先堆疊」**: 祖先堆疊(進入加入、離開移除)遇共用參照之菱形圖為 O(2^D)(深度 24 約 1.9 秒、28 逾 30 秒),而 `cloneDeep` 保留共用結構、`JSON.stringify` 本身對菱形圖輸出也是指數大小,但 `save(autoInsert:false)` 等不序列化之路徑會只剩檢核在燒. `WeakSet`(只進不出)同時涵蓋回邊與共用參照,O(節點+邊).
- **外審(2026-10-19)**: sol(`gpt-6.1-sol`/max)啟動約 74 秒即以 exit 1 結束,輸出含 `You've hit your usage limit ... try again at 10:41 PM`(判為額度用盡,不重派),改派 Argon(`dispatchAntigravity`,`gemini-4-argon-high`,`skipPermissions: true`,`addDirs` 只給審查資料夾; 測試指令靠副本置於 repo 之 `tmp/` 下由上層 `node_modules` 解析,不需把真實 repo 加入工作區)約 22 分鐘完成. **agy print 模式 stdout 只在結束時輸出**,「10 分鐘內無輸出」不能用 `stdout.log` 判活,改看審查者 `out/` 內檔案數與 `agy.exe` 行程. Argon 報告 8 條,逐條實測: 6 條屬實(其中 F-02/F-03 是刻意構造之物件,列為範圍邊界),引文有誤處(`pathId` 不存在、F-06 引的程式碼與實際不同)但結論可重現. 審查者的變異清單(SM01–SM06)抓到我方測試 3 類真缺格: 檢核先於讀取、已存在主鍵/同批重複之紀錄、代理對恰在 30 碼元處.
- **「檢核先於讀取」的測試夾具**: level 於主鍵 p0 以 `new Level(…, { valueEncoding: 'buffer' })` 放無法解碼之紀錄(`getMany` 讀到即拋解碼錯誤),lowdb 以壞 JSON 檔;先以「合法數據應失敗」作對照證明夾具有效,再驗帶範圍外 Date 者得到本檢核之錯誤. 夾具建立函數 `mkCorrupt` 是 level/lowdb 兩版測試唯一不同之處(連同 `mk`、`close`),由 `tmp/gen-lowdb-test.mjs` 以恰一處取代產生.

## 寫入入口前置處理移入 try(第 80 項,R-WRITE-ERR-01)(2026-10-20)

- **盤點「try 之外可因輸入而拋錯」不能只看建議書點名之 `cloneDeep`**: 實測 `iseobj(data)`(`for…in` 觸發 Proxy `ownKeys`、`isobj` 讀 `Symbol.toStringTag`)、`isearr(data)`(長度 1 時讀 `v[0]`)、`get(option, …)`(option 存取器)與 `del` 之同形 `cloneDeep` 皆會拋錯.以 `tmp/probe-claim.mjs`(4 入口 × 輸入表,印 reject / error 事件數 / change 數 / 資料庫是否不變)對 HEAD 先量,兩套件 34 格全為「reject 但 error 事件 0」.
- **早退 `return` 置於 try 內即可**: 無 `finally`,`return` 直接離開函數,不經 `catch` 之後之 `_cache = null` 與事件,故早退行為(不發事件、不重設快取)不變;勿因移入 try 而把早退改成 `res = …` 流程.
- **移入 try 後 `emitError` 會被餵入任意拋出值**: `getErrMsg` 對 null 原型物件(`String()` 拋 TypeError)、`message` 存取器拋錯、`toString` 拋錯者自身會拋錯,而 `emitError` 原把 `getErrMsg` 放在 `ee.emit` 之 try 內,拋錯即「不發事件只 console.log」,使不變式「恰一次」破功(外審 agy-opus F-01,實測).修在單一發射點 `emitError`(先取訊息、失敗用固定訊息 `unknown error`),不改逐筆路徑之 `getErrMsg`.
- **以「拋出值型別」為獨立軸**: 測試之拋出者不能只用 `Error`;`Error`、字串、數字、`null`、`undefined`、null 原型物件、`message` 存取器拋錯物件、`toString` 拋錯物件逐一入 4 入口;reject 值以 `Object.is` 比對拋出者本身(`undefined`/`null` 亦然,成敗以 `out.ok` 判,不可用 `out.err` 真值).
- **快取是否被重設要設法觀測,「失敗前後 `select` 相等」區分不了**(兩外審皆指出): lowdb 於快取熱時自實例外改寫 JSON 檔(鍵 `<db>:<cl>`),看 `select` 讀到檔案或舊快取;level 持獨佔鎖無法外改,改暫時包裝 `Level.prototype.iterator` 計 `select` 實際走訪次數(快取命中不走訪;包裝以 `hasOwnProperty` 記原狀,`after` 還原或刪除).`insertBulk` 之前置不經 iterator(用 `getMany`),故計次乾淨.
- **斷言要釘住規則之兩半**: 事件之 `data` 為「原值(同一參照)」與「複本(非同一參照但深度相等)」須分開斷言(`insert` 先讀 option 再複製→原值;`save` 先複製再讀 option→複本),只用 `deepStrictEqual` 兩者皆過等於沒釘;訊息須斷言「為拋出者之原訊息」(引擎訊息以關鍵字 `/primitive/`、`/constructor/`、`/call stack/` 比對,避免綁死 lodash/V8 版本),否則「改寫為泛用訊息」之變異存活(外審 minimax F-02).
- **變異法 `tmp/mutate-pre.mjs`**: 以「自 `async function XCore(` 至 `async function X(`」切出各 Core 本體,`H-*` 變異把該本體換成 `git show HEAD:` 之同名本體(比自寫反向文字替換穩),其餘變異以 `rep()` 錨點恰一處施作;副本置於 `<repo>/tmp/mut-pre/<名>/{src,test}`,以 `node <repo>/node_modules/mocha/bin/mocha.js` 執行,結果 `tmp/mut-pre.txt`.派生 lowdb 時同一腳本以 `<lowdb 根> WOrmLowdb.mjs` 參數執行.
- **環境事故(任務開始時)**: C: 槽可用空間為 0(其他程序占滿,約 2 分鐘後自行回升),此時 `ls`/`cat` 即回 `No space left on device`、較大寫入失敗;Edit/Write 對既有檔整檔改寫在此狀態有截斷風險,故先以 `df -B1 /c` 輪詢至 ≥ 1GB 且穩定再動手,之後以 `git diff --stat` 與 `node --check` 驗檔案完整.
- **外審派工**: `getQuotaCodex()`(`w-dispatch-ai` 頂層匯出,取 5 小時窗 `usedPercent`)可於派前判定 sol 額度用盡而不必空跑;Argon 以 `node C:/opensrcOper/tools/quota-agy.mjs` 查(`gemini-argon-wtu-weekly` 已用 98.47% 仍派,約 215 秒即 `RESOURCE_EXHAUSTED`、離開碼 3);agy-opus 約 8 分鐘完成且品質高(附可重現之變異與探針).**opencode 審查者之 bash 環境無 `rg`,且 `external_directory` 之自動拒絕會使整個行程提前結束**(minimax 第 1 次因 `cd` 至審查夾具外之真實 repo 而結束,無報告):提示詞須明寫「只存取 W/O、存取他處行程即結束」並要求先寫報告骨架;審查夾具置於 repo 之 `tmp/review80/<審查者>/{work,out}`,mocha 以絕對路徑指向 repo 之 `node_modules`(探測通過).

## 第 66 項批 1b 字串良構接線之經驗(2026-10-20)

- **接線與驗證流程**同 w-orm-lmdb 帳本 R-ORMSTR-01 與其經驗節(wsemi ≥ 1.9.24;案例表逐案套用、每案全新資料表、修前紅以 `git show HEAD:src/…` 之副本於 `tmp/pre` 執行〔`tmp/run-pre.mjs <src檔> <repo根>`〕、變異以 `tmp/mutate-generic.mjs <repo根> level` 對副本執行)。
- **level 之測試很慢**: LevelDB 每案開關約 190 ms,`test/unit-wellformed.test.mjs` 全檔約 8–9 分鐘;變異改以 `--grep` 子集(排除 val、type、free、gfs 組)執行,各變異與其對照組 M00 之失敗數比較(M00 在子集下因「案例完整度」計數案而恆有 1 案紅,以失敗數 > M00 判轉紅)。
- **`toctou:*:mutate-after-call` 之偏離**: level 之寫入入口經 `serialize` 佇列,`cloneDeep` 於 Core 內(輪到時)才做(帳本 R-WRITE-ERR-01 規則 1 要求前置處理全在 Core 之 try 內、外殼不讀輸入值),故呼叫後立即改動之輸入會被取用;該 3 案改以不變式斷言(資料庫內不得出現孤立代理),已於報告列為偏離待主控裁示。
- **save 合併後連現值檢核之陷阱(自己踩到)**: 一度對合併後之 `vm = merge({}, vv, v)` 再檢核,結果值內保有孤立代理之舊列(JSON 保真)被連坐——對該列之無關更新永久 `ok:0`;正解為 `vIn = merge({}, v)` 只檢核輸入側再以 `vIn` 合併(回歸測試與變異 M29 釘住)。
- **Date 檢核與良構檢核之順序**: 先放良構檢核使既有 `test/unit-date-write.test.mjs` 之「孤立代理鍵之路徑渲染」2 案轉紅(該案之鍵含孤立代理與範圍外 Date,期望 Date 訊息);改為 Date 檢核先、良構檢核後(兩者並存先報 Date,測試釘住)。
- **範圍外觀察(未修)**: `haskey(kp, v.id)`(wsemi `haskey` 為 `in` 運算子)使 id 為 `constructor`、`toString`、`__proto__`、`hasOwnProperty` 時 `insert` 回 `nInserted:0`(被當成已存在而不寫入)、`save` 回 `nInserted:0,nModified:1`——探測 `tmp/probe-proto-id.mjs`;lmdb 已於 2026-10-12 改用 Set/Map(見其經驗「判斷成員勿用 in」)。已列入報告待主控處置。**已於 2026-10-21 第 66 項批 1c run02 修正**(見下節與帳本 R-PKMAP-01)。
- **作業失誤**: Bash 內曾用 `cd` 與 heredoc 寫檔(違反全域 §8.1),其後改用 Write 工具與 quiet-run 之 `--cwd`。

## level-run01:診斷輸出單一出口與預設安全(第 153 項,R-DIAG-01)(2026-10-28)

- **站點很少,盤點仍要做全**: 本套件修前實際輸出僅 2 處(`emitChange`/`emitError` 之 catch `console.log(拋出值)`),但「底層驅動是否另有日誌」要實查——`level`/`classic-level`/`abstract-level`/`mingo` 與本套件所用 12 個 wsemi 模組皆無 console/stdout/stderr(Grep 時要排除註解行,wsemi 多數檔案的 console 都在 JSDoc 範例內);LevelDB 之 `LOG` 檔在資料庫資料夾內,不是 console.
- **無憑證套件的「連線字串不得輸出」(我的首版判斷錯了,外審更正)**: level 之 `opt.url` 是本機資料夾、無帳密.首版以「diag 不收 url/db/cl,故由結構保證不外洩」為由不做遮罩、`funLog` 直接交拋出值原參照;外審 F-01 以 `.ldb` 損毀重現:後端 I/O 錯誤文字 `IO error: <位址>/000005.ldb` 經 `error` 事件傳給訂閱函數,訂閱函數一轉拋,`logDetail`/`funLog` 細節就含完整位址——「diag 不收」不等於「細節不含」,因為細節是**使用端拋出之值**,其內容可夾帶本套件交給它的任何文字.教訓:凡「A 不會出現在輸出」之結構性論證,要檢查**所有流入使用端回呼之資料**(事件參數、reject 訊息)是否含 A.改為與 reladb 同法:`cpMask` 拷貝 + `getSecrets` 遮罩清單(儲存位址原樣/反斜線/絕對路徑形式與 url).測試用真實 `.ldb` 損毀(寫 50 筆×2000 字元→關閉→重開令 log 轉 `.ldb`→覆寫 `.ldb`→`selectByPk` 全部失敗)產生真後端錯誤,並先斷言「error 事件文字確含位址」以免空轉.
- **funLog 交原參照的風險**: 首版 `detail` 為原參照;外審 F-02 證明訂閱函數拋出帶 `{data, res}` 之錯誤、`funLog` 依文件「自行遮罩」原地修改,會篡改後續事件參數與 `save` 之 resolve(因 `change` 事件的 `res`/`data` 與回傳值共用物件).一律交拷貝.
- **`util.types` 的取得**: `dist` 由 rollup 打包為 UMD,`toolg/gDistRollup.mjs` 之 external 只列 level、mingo,且 `level` 有 browser 版——靜態 `import 'util'` 在非 Node 環境會壞(外審實測 rollup 本身可建置,僅警告).改以 `globalThis.process.getBuiltinModule('util')` 於執行期取得(Node ≥22.3),取不到退回 `instanceof`(`mkTypes(null)`,測試以注入 `FB` 覆蓋);bundle 後以 UMD 實跑確認 `isProxy` 可用(`./tmp/level-run01/build-dist.mjs`).Proxy 的原型鏈走訪必須設層數上限(外審 F-03 的循環 `getPrototypeOf` trap 會同步卡死);測試中若變異會造成同步無窮迴圈,變異執行器須有逾時(視為殺死).
- **其他外審修正(全屬實)**: `swallow` 對原生 promise 用 `Promise.prototype.then.call`(自有 `then` 被覆寫為 null 的 rejected promise 否則洩 unhandledRejection),二層 thenable 的 `then` 只讀一次;`constructor`/`name` 沿原型鏈查找時**遮蔽層即止**(accessor 或 null 不越層取祖先);`getDiag(optLog)` 入口一律 `getOptLog` 正規化(傳 `{logDetail:true}` 未包裝時 `funLog` 為 undefined 會誤入 funLog 分支而全無輸出——w-serv-orm/reladb 亦有同型缺口,可回報);`RE_ERR_CODE` 的 `E[A-Z0-9]` 會放行 `E123456789`/`EMP00123`,改 `E[A-Z]{2,15}|E2BIG`(`ERIC` 仍過,屬白名單固有限制).
- **測試設計教訓(外審 F-07,11 個變異中 6 個原存活)**: 測試偏重 `change` 站而漏 `error` 站(同型站點須對稱跑,現以 `SITES` 表驅動兩站);情境腳本未觸發 `selectByPk` 之 error(現加 closed 後七個操作);靜態掃描只擋 `console.` 而漏 `console?.log`/別名/括號存取(現擋 `\bconsole\b` 等字邊界並測掃描器本身命中各寫法);後備輸出只斷言 `includes('unprintable')` 而不驗 label(現精確比對 args);斷言 `diag(` 出現次數恰為 2 會綁死重構(已刪,改以行為斷言).另:審查者的變異腳本以字串替換首版原始碼,改碼後樣式找不到會直接中止(`did not change …!`),不能原樣重跑——要把其變異改寫成對新碼的等價變異放進自己的框架;改寫 M-09(原型鏈只讀兩層)時**首跑存活**,因測試的繼承深度都只有 1~2 層;原型鏈走訪類的邏輯,測試的鏈深至少要 ≥ 4(實例＋3 層無自有屬性)才能殺死「只讀固定層數」之變異.- **測試 helper 踩雷**: ①`mkOpt` 若以展開語法 `{...extra}` 合併選項,extra 之 getter 在 helper 內就被執行,「讀取選項拋錯」案送不到 WOrm;改以 `Object.defineProperties(opt, Object.getOwnPropertyDescriptors(extra))`.②擷取 console 時要同時攔 `process.stdout/stderr.write` 與 `warning` 事件,擷取結束後再讓出兩個 macrotask.③回傳契約之預期值必須由 git HEAD 之程式產生(`git archive HEAD src | tar -x -C ./tmp/…` 後以 `genDiagGolden.mjs` 指向該副本),不可用現行 src.
- **修前紅的做法**: 新增 `getDiag.mjs` 後,把它複製進 HEAD 副本(`tmp/level-run01/pre/src`)再跑最終測試:wiring 相關 15 案紅、getDiag 單元與舊格式回歸守則綠;單獨對無 `getDiag.mjs` 之 HEAD 跑只會得到 `ERR_MODULE_NOT_FOUND`(整檔載入失敗,證據力弱).
- **意外發現(修前缺陷)**: 修前 `emitChange` 之 catch 內 `console.log(err)` 若本身拋錯(拋出值之 `util.inspect.custom` 拋錯),該錯自 `emitChange` 外傳,使本已成功之 `insert` reject(HEAD 副本實測 `Error: inspect boom` 自 `await wo.insert` 拋出).新出口吞下輸出自身之拋錯,屬補正;已寫入 README/帳本.
- **外審**: terra(`gpt-6.1-terra`/max)2026-10-28 08:37 探測即回 `You've hit your usage limit … try again at 10:56 AM`(離開碼 1,3 秒),依規則改派 Argon(`gemini-4-argon-high`,agy 1.4.8,`skipPermissions:true`,`addDirs` 含副本、產出夾與兩個參考 repo 之 `src`);探測(讀中文檔首行＋寫檔)通過再派.
- **作業失誤(已被守門擋下)**: 曾以 Bash heredoc 寫暫存腳本(`cat > … << EOF`)被主控守門 hook 擋下(無檔案寫入),其後一律用 Write 工具;`sed -i` 同樣被擋,批次改識別字改用 Edit `replace_all`.

## 第 66 項批 1c run02:主鍵存在性對照表改 Map(R-PKMAP-01)(2026-10-21)

- **上節「範圍外觀察(未修)」已修**: `getKpValues` 回 `Map`,`insert`/`insertBulk`/`save`/`del` 以 `has`/`get`/`set`/`delete` 存取;`haskey` 之 import 隨之移除(level 無其他用處)。比照 w-orm-lmdb「判斷成員勿用 `in`」之經驗(2026-10-12)。
- **盤點以「對照表之所有讀寫站點」為單位**(`haskey`、`get(kp, …)`、`kp[id] =`、`delete kp[id]`),不只找 `haskey`;`kp['__proto__'] = v` 並非建立自有屬性而是改寫 `kp` 之原型,故以 `__proto__` 為主鍵之列其欄位名會被誤認為他筆之主鍵。level 實測(修前): 同批 `save([{id:'__proto__',name:'y'},{id:'name',q:1}])` 讀回 `{"0":"y","id":"name","q":1}`(第二筆以第一筆之 `name` 字串為現值,`merge({}, 'y', …)` 把字串展開為索引鍵),屬資料損毀;`del` 對不存在之 12 個成員名回 `nDeleted:1`(實未刪)。
- **測試**: `test/unit-protokey.test.mjs`(242 案,約 57 秒);lowdb 之同名檔由 `tmp/gen-lowdb-protokey.mjs` 自本檔產生(標記行 `//=== 以下兩套件相同 ===` 以下為共用主體)。修前紅以動工前之 src 副本(`tmp/pre/src/WOrmLevel.mjs`)搭最終測試於 `tmp/pre` 執行(143 紅/99 綠;對照組 0 紅)。變異 `tmp/mutate-protokey.mjs <repo根> WOrmLevel.mjs`(8 項全紅;`saveCore` 之 `kp.get` 改回物件為等價變異:僅於 `kp.has` 為真後讀取)。變異輔助須以**賦值語意**重建一般物件(`o[a] = b`)才與修前行為同義,`Object.fromEntries` 不重現 `__proto__` 改寫原型之特性。
- **作業事故(已清除)**: 以 `for p in "路徑:檔名"` 之 `${p%%:*}` 拆分時被磁碟機代號 `C:` 之冒號截斷,於 lmdb 工作目錄誤建空資料夾 `./C/tmp/pre/{src,test}`(無檔案),已即時 `rmdir` 清除並回驗;含磁碟機代號之路徑勿以冒號作分隔符。

## mig-level:診斷輸出與遮罩改用 wsemi 共用實作(第 161 項,R-DIAG-01)(2026-10-29)

- **同一個 catch 內混有「外來值」與「套件自身固定詞彙」時,用登記而非比對來分辨**: 各 `*Core` 的 `try` 內同時會拋後端/使用端存取器之值與本套件自己的 `invalid id`、`can not insertBulk by existed id[..]` 等;以模組內 `WeakSet` 登記(`mkOwnErr(msg)` 建立並 `add`)、catch 站點 `own.has(err) ? err : diag.err(err)`.不用 `instanceof`、訊息前綴比對(易被使用端偽造)；未登記者一律當外來值——漏登記只會多遮,不會漏遮(fail-closed 方向).
- **無憑證套件的對外遮罩測試要用「通用規則」形態**: level 的 `reject` 清單恆為空(`paths` 只進 `detail` 清單,Q3),語料中依賴 `ctx.sec.password` 的 R04/R02 不適用;接線測試改用不需登記的通用形態——`postgres://alice:Pw9xQz7@host/..`(→ `postgres://***@host`)與語料 T07/T03 的輸入(期望值直接取語料的 `expect.check`,不手寫).不能把密碼代換成儲存路徑去測 reject(路徑對外不遮,會得到相反結論).
- **語料驅動時秘密要代換成「本實例真正宣告的秘密」**: `ctx.sec.password = 儲存位址`,讓語料的 `make`/`check` 原樣可用;洩漏檢查不用語料 `verify` 的 5 字元窗(儲存位址含 `/test` 等片段,與 Error stack 的檔案路徑重疊必誤報),改逐字比對本套件宣告的各形式(原樣、反斜線、絕對路徑兩種斜線)＋`ctx.extra`.語料新增 `wire` 案時用「歸類全集」案強迫重新歸類(適用/不適用+理由).
- **wire 案歸類全集紅燈時以失敗訊息之差集為準**(orm233,wsemi 1.9.36: 派工說新增 A11,實際差集為 A11、C14、U22 三案,語料 wire 案共 23): 判定是否適用須追診斷輸出路徑——`src/WOrmLevel.mjs` 只引入 `getDiag`、`getDiagSecrets`,兩者(wsemi `getDiag.mjs`、`getDiagSecrets.mjs`)皆不引入 `genDiagFunLog`;本套件宣告 `paths`、`codes:['level']`、`safeKeys:['mode']`,無 `types`、`conns`——故三案皆歸 NA(附理由).不只 Grep `src` 有無字樣.
- **後端接縫**: 後端無法自然產生含憑證的錯誤,故測試暫時以 `Object.defineProperty(Level.prototype, 名, { value: 拋錯函數 })` 取代(`level` 與 `src` 解析到同一模組);還原要區分「原本有自有描述子」與「繼承來的」(後者 `delete`),`try/finally`;`mocha --parallel` 是各檔獨立行程,不互相汙染.被測物是 catch 站點的接線,不是後端.
- **逐筆 `err`(save/del 的逐筆 try)幾乎無法由外部觸發外來錯誤**: 逐筆 try 內只剩 `merge`/`isEqual`/`get` 等純函數,資料已是 `cloneDeep` 複本.可行的觸發法: 類別實例的原型上放**可列舉存取器 `id`**(`cloneDeep` 只複製自有鍵,原型存取器保留在複本上),「第 N 次讀取起拋錯」;N 依內部讀取次數而定(del 2、save 5~9),測試對 limit=2..16 逐一試,斷言至少一個落入逐筆路徑(防空轉)且每個結果(逐筆 err 或整批 reject)皆已遮——不綁內部讀取次數.注意 `change` 事件的 `data` 帶該存取器,記錄事件時不可 `JSON.stringify(data)`,只記 `res`.
- **固定詞彙測試的「誤包」變異首輪存活(教訓)**: `outMsg` 一律 `diag.mask` 的變異存活,因逐筆固定詞彙(`invalid id: string is empty ..`)本來就不含任何會被遮的內容,誤包也不變.固定詞彙測試必須用**會被遮的回顯值**(使用端鍵名 `token=abc123456789` 出現在 `invalid data: .. at [data[0].token=abc123456789]`),並附「同一段文字若為外來值則被遮」的對照(非空轉).
- **wsemi 1.9.31 與自寫版的行為差**(README Breaking changes 已列): `errType` 只列內建錯誤類別名(自訂子類別→`Error`,需 `types` 宣告才列);`errCode` 只列明列集合(整數、`ERR_xxx`、`ERIC` 類不再列;`LEVEL_xxx` 靠 `codes:['level']`);`logDetail` 輸出變 `console.log(標籤, 細節)`;遮罩拷貝 Map/Set 保持型別;外來值帶自有存取器 → `diag.err` 交遮罩副本(`unit-write-pre-error` 的 `message` 存取器案從「reject 為拋出者本身、事件 `unknown error`」變「副本、`[Getter/Setter]`」,存取器不被執行).全套首跑即由此案 4 紅發現,不是診斷測試發現的——遷移後務必跑全套.
- **UMD 驗證**: `tmp/mig-level/buildDist.mjs` 以 `w-package-tools` 的 `rollupFiles` 打包到 `./tmp/mig-level/dist`(不動 `./dist`)後以 `require` 載入實跑(預設輸出與 reject 遮罩皆符);bundle 內 `require("util")` 在 HEAD 的 `dist` 即有 1 處,非本輪引入.
- **作業**: 守門擋 `cd`、`sed -i`(改用 Edit);測試一律 `quiet-run --lock`;全套 `npm test` 約 7m48s;變異 23 項約 3 分鐘(`--bail`,副本於 `tmp/mig-level/mut/<名>`,逐項建/刪).

## olv492i:wsemi 1.9.69 判斷函數回布林後之可讀性探針(R-PROBE-01)(2026-11-19)

- **盤點「防線依賴判斷函數拋錯」之站點,以「舊版對新版之站點 × 敵意值矩陣」為準,不靠讀碼推測**: 以 `npm pack wsemi@<舊版>`(registry 指向 Verdaccio)解到 `./tmp/<名>/oldrun/node_modules/wsemi`,把 HEAD 之 `src` 複製到 `oldrun/src`(解析時向上找得到本庫 `node_modules`,故 `level`、`lodash-es` 等不必重裝),同一支矩陣腳本對「舊 wsemi＋HEAD」「新 wsemi＋HEAD」「新 wsemi＋修正」各跑一次後逐格比對:前兩者之差異格即站點全集(160 格中 56 格),第一與第三者之差異格即修正之殘餘(9 格,見帳本已知邊界).不在矩陣內之站點(複本、DB 讀出值、`find`、拋出值之 `message`)修前修後皆同,可據以判「不適用」.
- **探針範圍對齊「舊判斷函數實際讀了什麼」,不只「標籤＋ownKeys」**: 舊 `iseobj` 之 `for...in` 沿**原型鏈**每一層列鍵、對各**字串鍵**讀 `getOwnPropertyDescriptor`(不處理 Symbol 鍵),舊 `isearr` 於 `length === 1` 時讀 `[0]`;只探標籤＋第一層 ownKeys 會漏掉「只在描述子陷阱拋錯」或「敵意 Proxy 在原型鏈上」者(獨立複審以原型為 `ownKeys` 拋錯之 Proxy 實測 8 格,修前 reject、探針不全則修後早退 `n:0`),對 Symbol 鍵讀描述子則過嚴(僅 Symbol 鍵之 Proxy 修前早退、探針會拒收).純量站點(`isstr` 系)舊讀法只有標籤,探針用 `probeTag` 即可;容器探針不對 Date、Map、Buffer 等列鍵(舊 `iseobj` 因標籤不符早已為假,列鍵會對大型二進位配置與長度同量之鍵).
- **探針放在判斷函數回 `false` 之分支內(分辨 `false` 之原因),不放在判斷之前**: 先探針會讓有效輸入多讀一次(單元素陣列多執行一次 `[0]` 存取器、大物件多走一遍鍵),且探針成功後判斷函數之讀取若在第 2 次才拋錯,拋錯被判斷函數吞掉而靜默早退(獨立複審以「第 2 次讀取拋錯」之計數物件重現).改為「判斷為假 → 探針」後,有效輸入之讀取次數與修前相同(測試以 `isearr + cloneDeep` 之次數為基準釘住),代價為「只在第 1 次讀取拋錯」之有狀態物件(規則 4 已知邊界).
- **`cloneDeep` 複本不等於「呼叫端已隔離」**: 複本保留原型,類別實例原型上之存取器 `id` 於複本上仍會執行呼叫端之程式,`get(v,'id')` 讀到之值可為不可讀者;`procPk` 之 `isestr(get(v,'id'))` 因此不能一概列「內部值」不探針(獨立複審發現,矩陣②之 18 格:修前 reject 為拋出者原訊息,未探針則 reject 但訊息被改為 `Cannot set property id of #<P> which has only a getter` 或固定詞彙,`save` 於有 setter 時甚至變為逐筆 `ok:0`).盤點「複本/內部值」之不適用時,要以含原型存取器之類別實例實測,不只讀碼.
- **舊 `isbol` 為 lodash `isBoolean`,另讀 `has` 陷阱**: 與 `isstr`(`Object.prototype.toString.call`)之讀集不同;1.9.69 之 `isbol` 改 `typeof` 後不再讀.僅 `has` 陷阱拋錯之 Proxy 作 `returnList`/`useCache`/`autoGenPk` 之差異屬非語意所需之偶然讀法,列已知邊界並以測試釘住,不為它擴大探針(否則容器站點會多拒收修前接受之輸入).
- **探針拋原錯誤、不包裝**〔2026-11-20 已被取代: 改用 wsemi `chkReadable`、訊息改固定詞彙,見下節 oro557b〕: R-WRITE-ERR-01 規則 2 與既有測試皆要求訊息為拋出者之原訊息(`ownKeys-boom` 等),故探針不回 `{ ok, msg }`、不加前綴,站點於 `try` 內直呼即走原 `catch`;建構層則同步拋出(同修前).
- **變異會汙染 cwd**: 移除 `opt.url` 探針之變異使建構落到預設位址 `./_db`(相對 cwd,與 `unit-basic` 共用),跑完於 repo 根留下 `_db/worm/c`;跑完須查 `ls -d _db*` 並清除自己建立者(`.gitignore` 含 `_db*`,不會被 git 看見).`unit-probe-readable` 之 `opt.url` 可讀而型別不符之對照因此不測(預設位址與他檔共用).
- **wsemi 1.9.69 之包裝物件語意變更不屬探針可補**: `isstr`/`isbol` 改 `typeof` 後 `new String`、`new Boolean`、`new Number` 不再被認,本庫之 `opt.url` 等、`option.returnList`、`id`、單元素陣列內之空包裝物件行為隨之改變(帳本 R-PROBE-01 已知邊界③,矩陣②之 15 格);這些值可讀,探針分辨不了,也不該為此自寫判定(依自有套件使用界線),列待裁示.
- **既有測試之「src 檔案清單」釘住**〔2026-11-20: 探針檔已刪,清單改回兩個檔〕: `unit-diaglog` 之單一出口掃描以 `deepStrictEqual` 釘住 `src` 只有兩個檔,新增 `src` 內部模組會使其轉紅(全套才現形,單檔跑不到);其意旨是「無自寫 `getDiag.mjs`」,改清單時一併確認其餘掃描案(不得出現 `console`、`process` 等)已涵蓋新檔,並於帳本與報告註明.另該檔之 `throw` 站點全集以計數釘住(`mkOwnErr` 12、`new Error` 3、`diag.err` 2、`throw` 共 17),新增任何 `throw` 站點須同步改計數與註解.
- **作業**: 單檔 `unit-write-pre-error` 約 7 秒、與新檔合跑約 15 秒;變異 25 項＋基準＋HEAD 約 8 分鐘(腳本整支包在單一 `quiet-run --lock` 內,逐項於 `tmp/<名>/mut/<id>/` 複製 `src`＋`test` 後單項改動,跑完刪副本;`opt.url` 探針被移除之變異會在 repo 根建 `_db/`,跑完清掉);git-bash 傳 Windows 路徑給 node 時反斜線被吃掉(`decision-log.mjs` 之任務資料夾用正斜線).

## oro557b:主鍵「給了而非字串」與 wsemi `chkReadable`(R-PKGIVEN-01、R-PROBE-01)(2026-11-20)

- **「未帶」之判定不得借語意會隨 wsemi 版本改變之判斷函數**: 原 `procPk` 以 `!isestr(id)` 當「未帶」,wsemi 1.9.69 後 `String` 包裝物件(及任何非字串)被靜默換成新主鍵寫入,且測試全綠(舊測試以 `id: 12345` 斷言「被補主鍵」,反而把錯行為當規格,見 `unit-wellformed`).改為以 `=== undefined/null/''` 判未帶,其餘交 `chkPk`(`chkOrmStr`)判給了之值;改規則前先 Grep 測試中「該輸入形狀被當成正常」之案(全套才現形).
- **修前修後以「入口 × 輸入」逐格矩陣核對,比單看新測試紅綠可靠**: `tmp/oro557b/probe.mjs <label> <src>` 對同一組格(320 格)輸出 JSON,`diff.mjs` 逐格比對修前後;腳本先 `process.chdir` 至暫存夾,使 `opt.url` 為非字串時落到之預設位址 `./_db` 在暫存夾內(不汙染 repo 根),且每格前重置 `./_db`(否則同一預設位址使後格因「主鍵已存在」假失敗).
- **失敗通道不隨 `autoGenPk` 改變是規則,不是巧合**: 同一組「給了而非字串」之 id,`autoGenPk` 為 true 與 false 之訊息與通道須同;`save` 於 `autoGenPk:false` 原把它整批 reject(與未帶同形),現改逐筆 `ok:0`——這是不相容變更,README、帳本與 JSDoc 皆列.未帶與給了並存於同批且 `autoGenPk:false` 時 `procPk` 先報未帶(已知邊界,兩者皆整批 reject).
- **`chkReadable` 不呼叫存取器 → 單元素陣列 `[0]` 存取器須由呼叫端自讀**: `isearr` 唯一依賴元素值之情形,存取器拋錯回 `false`,`chkReadable(data, { elements: 'first' })` 回 `''`(視為可讀),若不自讀則該輸入由 reject 退回早退 `n:0`(靜默).自讀只放判斷函數回 `false` 之分支內,有效輸入之讀取次數不變(`unit-probe-readable`〈valid data is not probed〉);變異「不自讀」紅 4.
- **wsemi 對照表之「超集」是真的,照抄會多出行為**(獨立複審指出): `{ ownKeys: true }` 對任何標籤皆讀自有鍵,故「陣列 Proxy 而 `ownKeys` 陷阱拋錯,且 `isearr` 為假(空陣列)」者由輸入無效早退改為 reject,且大型 Buffer/TypedArray 之無效輸入會配置與長度同量之鍵.改為 `ownKeys: isobj(data)`(僅標籤為 `[object Object]` 者,同 `iseobj` 之 `for...in` 實際讀鍵之範圍,也同本地探針時之範圍),以「空陣列 Proxy 之 `ownKeys` 陷阱呼叫次數為 0」與「有效物件 Proxy 之呼叫次數同 `iseobj + cloneDeep`」之計數案釘住(變異 R2-13 紅 9).照對照表換探針時,先比對新舊探針之讀取範圍差,不照單全收超集.
- **經原型存取器讀出之 `id` 之訊息名稱**: 讀取即拋錯之值依共同規則二為 `invalid data[<k>].id: must be a readable value`(原失敗通道,`save` 亦整批 reject);而可讀而非字串者依規則一為 `invalid id: not a string`.兩條規則對「讀取即拋錯之 id」之措辭有重疊,本庫以「標籤不可讀 → 規則二;其餘 → 規則一」切分,報告列待裁示.
- **作業**: 修前紅不必 `git stash`/`checkout`: 開工前 `cp -r src tmp/<名>/src-head`,修前紅時建 `tmp/<名>/head/<套件名>/{src,test}`(HEAD 之 `src` 搭最終 `test`),`quiet-run --cwd` 指向它(目錄名取套件名使測試鎖之套件身分不變),`node_modules` 靠向上解析找得到 repo 之 `node_modules`(`./tmp` 在 repo 內),不需連接點.變異腳本(`tmp/oro557b/mutate.mjs`,21 項 + 2 組基準)整支包在 `quiet-run --lock` 內約 5 分鐘.首輪 6 檔合跑 8 分 23 秒(`unit-wellformed` 為大宗),單跑 `unit-pk-given`(379 案)8 秒.

## oro557b2:全族對齊口徑 A1~A6(R-ALIGN-01)(2026-11-20)

- **容器與成員之辨法**: 讀 `option`/`opt` 之成員拋錯時,於 `catch` 內以 `chkReadable(容器)` 分辨——容器標籤不可讀(已撤銷之 Proxy、`get` 陷阱對任何鍵含 `Symbol.toStringTag` 皆拋)為 `invalid option`(建構 `invalid opt`);容器可讀(僅對該鍵拋錯之 `get` 陷阱、拋錯之自有存取器)為 `invalid option.<鍵>`.`chkReadable` 不呼叫存取器,故成員拋錯只能靠「讀取拋錯 → 事後問容器」.標籤拋錯而成員皆讀得到者(`Symbol.toStringTag` 拋錯但成員正常之 Proxy)照常運作,不是 A1.
- **複製處不分辨頂層與巢狀,一律 catch 全轉**: `cloneDeep` 之拋錯(巢狀已撤銷 Proxy、陷阱拋錯、拋錯之存取器、原型為 null 之 Date、50000 層之 stack overflow)一律 `invalid data: must be a readable value`——單一 `copyData` 包裝,4 個寫入入口各一呼叫(測試以逐入口變異把其中一處改回 `cloneDeep` 逐一轉紅).連原本釘住「reject 為拋出者本身」之 `thrownValues`(8 種拋出值型別)亦改為固定詞彙,拋出者之型別與文字皆不外洩.
- **複本之後仍會執行呼叫端程式**: `cloneDeep` 複本保留原型,原型上之存取器於複製之後仍被執行,讀取點遠不止 `get(v,'id')`: `v.toJSON`(`chkDataDate` 之 `isDateNode`)、繼承可列舉存取器(`chkOrmData`、`save` 之 `merge({}, v)`)、補主鍵之 `v.id =`(setter).以 `guardRead(fn)` 包這些站點(本套件自身之 `own` 錯誤原樣通過,其餘轉固定詞彙),並以探針枚舉(複本之後讀取點 × 存取器種類)確認無遺漏;`getKpValues`/`kp.has(v.id)` 對有狀態之存取器(第 N 次讀才拋錯)之重複讀取不補(已知邊界).
- **error 事件之 `data` 為 `null` 之判準**: 以「不把不可讀之值或含其之複本交給訂閱函數」為準,故入口階段(option/data 讀取、複製、`procPk` 之 id 讀取/指派、複本內存取器)之拒絕皆 `null`(`mkInErr` 登記於 `inErrs`,各 Core 之 `catch` 見之即 `data = null`),入口之後之拒絕(Date 範圍、`without valid id`、`not a string`、主鍵衝突)資料可讀,仍交複本.`procClosed` 先於一切,原交呼叫端原值: 只在型別標籤不可讀(`chkReadable` 只讀標籤、不拋錯)時改 `null`,可讀者行為不變.
- **斷言 `null` 不可用 `assert.equal(x, null)`**: 失敗時 `x` 可能是已撤銷之 Proxy,`equal` 之失敗訊息 `inspect` 它,mocha 之失敗序列化(平行模式為 structured clone)拋錯,**整個 mocha 行程無摘要即異常結束(離開碼 0)或掛起**(修前紅之首輪即因此掛滿 10 分鐘).改用 `assert.ok(x === null, 訊息)`;含敵意值之斷言訊息皆不得內插該值.`quiet-run` 對「離開碼 0 但無 passing 摘要行」會警告,據此發現.
- **修前紅之執行**: 修前 `src` 搭最終測試,掛起/崩潰之測試比真正失敗更耗時;`--timeout 20000`(非 180000)可使掛起者快速失敗;以 `--parallel` 跑(約 15 秒;`--no-parallel` 7 檔約 9 分).
- **改規則後全套才現形之測試: 以「使用端存取器拋錯」當外來值注入點者**: `api-diagwire`(R-DIAG-01 之遮罩接線)原以資料欄位之存取器拋出含憑證之值,當作「外來值經 `outErr` 遮罩」之注入點;A3 後複製階段之拋錯轉固定詞彙,該注入點不再通到 `outErr`,15 案轉紅(單跑相關 6 檔看不到,全套才現形,同 oro557b 之 `id: 12345` 形狀).處置: 外來值之注入改用後端接縫(`withBackend('getMany', () => 拋出值, …)`,測試本即以此測後端錯誤),原「存取器拋出」案改驗新契約(固定詞彙、拋出者之值與憑證皆不外洩);`mkCounted` 逐筆案改為「固定詞彙或已遮罩」二者之一並要求各通道至少一例(非空轉).改拋錯處理前,先 Grep 測試中以「存取器/Proxy 拋錯」為注入手段者(`getter`、`mkBadData`、`throw` 於 `get()`),估計其被影響之範圍.
- **變異排除原始碼文字鎖定之測試**: 變異腳本以 `--grep 'single owner|source: the copy and read sites' --invert` 排除只讀 `src` 文字之案(呼叫行全集、`copyData(data)` 計 4 等),使「轉紅」確為行為斷言所致,而非計數案偵測到文字被改.

## olv569:主鍵只認自有可列舉之資料屬性(R-PKOWN-01)(2026-11-20)

- **缺陷之形狀(1.0.69 實測 98 格,入口 × 列形態 × 有無同值列 × `autoGenPk`)**: `cloneDeep` 保留原型,`procPk` 以 `get(v,'id')` 讀得繼承值而判已帶,level 之 `valueEncoding: 'json'` 只存自有可列舉屬性,故**以繼承值為鍵、值不含 `id` 欄**寫入(主鍵遺失);庫內有同值列時 `insert` 跳過、`insertBulk` 整批 reject、`save` 覆寫、`del` 刪除.只靠 `select()` 看不到「鍵」,驗證須關閉實例後直讀 `Level`(鍵與 `id` 欄是否相等),這才抓得到「鍵對、值無 id」之形狀.
- **改規則會吃掉「把繼承值當正常」之既有測試,全套才現形**: 原型存取器 `id`(類別 `get id()`)在 `unit-pk-given`(回傳字串者以之為鍵、回傳 5/包裝物件者拒為 `not a string`)、`unit-probe-readable`(回傳已撤銷 Proxy 者拒為 `invalid data`)、`unit-align-readable`(補主鍵 setter 拋錯)、`api-diagwire`(以原型存取器之第 N 次讀取拋錯作逐筆遮罩之注入點)皆被當成「主鍵來源」;新規則下它是未帶,其回傳值不探測、補主鍵不執行 setter,50+2 案轉紅.改規則前先 Grep 測試之 `get id()`/`Object.create({ id` 形狀;改寫時各案改釘新契約(補新主鍵／依未帶 reject),不是刪案.
- **「取值」與「查描述子」之次序以讀取次數釘住,不以結果釘住**: 條件寫成 `id === undefined || … || !isOwnPk(v)`,而 `id = get(v,'id')` 在其前: 若改成「先查描述子、繼承者不取值」,結果全同(未帶即補),唯一可見之差是繼承存取器 `id` 之 getter 讀取次數(1→0)與存取器拋錯是否仍轉固定詞彙——故測試釘「繼承存取器 getter 讀 1 次(`del` 為 2 次,既有)」與既有 A2「id getter throws」,變異 M02 由此殺死.
- **`[null]`/`[undefined]` 不進 `procPk`**: 陣列元素為 `null` 之輸入為輸入無效之早退(`n:0`/`[]`);非物件之列只有字串、數字等會進 `procPk`(補主鍵之賦值拋原生 `TypeError`,既有行為),故 `setPk` 對非物件維持賦值,不用 `defineProperty`(其錯誤訊息會變為 `Object.defineProperty called on non-object`,測試以訊息釘住).
- **逐筆遮罩通道之刺激消失**: `save` 逐筆路徑原只有「原型存取器 `id` 於複本之後第 N 次讀取拋出外來值」能觸發 `outMsg` 遮罩;`id` 成自有屬性後該刺激不存在(`unit-save` 本即註明逐筆失敗路徑不可達),`outMsg` 站僅餘原始碼鎖定.改寫 `api-diagwire` 時如實降級並列入帳本已知限制,不以人工造出之刺激(如污染 `Object.prototype`)掩蓋.
- **作業**: 修前紅以 `git archive HEAD src | tar -x -C tmp/<名>/old` 解出修前 `src`,複製最終測試與 `test/lib` 到 `tmp/<名>/old/test/`,`npx mocha` 直接指向該路徑(`node_modules` 靠向上解析找得到 repo 之 `node_modules`,不需連接點);變異腳本(`tmp/<名>/mutate.mjs`,每項於副本單項改動後跑 2 個相關檔)**整支包在單一 `quiet-run --lock` 內**(`MUT_DIRECT=1` 時逐項直接 `node node_modules/mocha/bin/mocha.js`,不再各自取鎖): 他套件測試把 CPU 占滿時,每個 `--lock` 要等閘門至多 15 分鐘,逐項各自取鎖 16 項會拖數小時;包進單一鎖後 16 項＋全套共 23 分(變異 13.6 分、全套 8.9 分).**改了測試或 `src` 後須砍掉並重跑進行中之變異**(副本於各項開始時才複製,中途改檔使結果混了兩個版本);砍自己起之行程用 `taskkill /F /T /PID`,殘留鎖會於下次取鎖時自動回收.變異替換字串須與 `src` 文字逐字唯一相符(改 `src` 後先驗 `PATCH-FAIL` 為 0);腳本內陣列順序即執行順序(新增項插在中間時其結果行會早於舊序號出現).
