# w-orm-level
An operator for level in nodejs.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-orm-level.svg?style=flat)](https://npmjs.org/package/w-orm-level) 
[![license](https://img.shields.io/npm/l/w-orm-level.svg?style=flat)](https://npmjs.org/package/w-orm-level) 
[![npm download](https://img.shields.io/npm/dt/w-orm-level.svg)](https://npmjs.org/package/w-orm-level) 
[![npm download](https://img.shields.io/npm/dm/w-orm-level.svg)](https://npmjs.org/package/w-orm-level) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-orm-level.svg)](https://www.jsdelivr.com/package/npm/w-orm-level)

## Keypoint

level 無條件寫入、無比較並交換亦無交易，故 `insert` 的「檢查主鍵不存在與寫入」與 `save` 的「查找主鍵與更新或插入」，其原子性由本套件自行提供，且跨行程併發無法支援。

**LevelDB 對資料庫目錄持有 OS 層之獨佔鎖（`LOCK` 檔）**，一個目錄同時只能由一個實例開啟：本行程持有期間，其他行程（以及同一行程內指向同一目錄的第二個實例）一律於開啟時失敗，錯誤碼為 `LEVEL_DATABASE_NOT_OPEN`。

故跨行程併發不是「保證失效」而是「無從發生」——不會有兩個寫入者同時操作同一目錄，也就不存在計數失準或資料損毀之風險，後開者是明確失敗而非靜默錯亂。

### 條件(find)白名單 (Condition whitelist)

`select` 與 `delAll` 共用同一個 `find` 條件與同一道檢核，於呼叫入口執行(已關閉判斷之後、任何讀取之前，不占用序列化佇列)。檢核為 `wsemi` 之 `cvOrmFind`(w-orm 系列共用)，其後查詢與刪除只使用檢核所回傳之複本，不再讀取呼叫端傳入之物件。條件不在白名單內者整批 reject，訊息為 `invalid find: <原因> at [<路徑>]`，於 reject 之前發出一次 `error` 事件，不讀取、不刪除任何數據，亦不發出 `change` 事件。

接受：

- 未給、`undefined`、`{}`：全部數據。`delAll()` 不給條件即刪除全部，須審慎使用、非必要不用；可先以 `select(find)` 確認 `delAll(find)` 之命中範圍。
- 欄位等值 `{ 欄: 純量 }`，多欄為 AND。純量為字串(不含 NUL 字元與孤立代理字元)、有限數字、布林、有效 `Date`(年份須介於 0000–9999，範圍外 reject，見下方 Date 節)；`null` 僅可用於欄位等值、`$eq`、`$ne`。
- 欄位運算子 `$eq $ne $gt $gte $lt $lte`(值為純量)與 `$in $nin`(值為純量陣列；`$in: []` 恆假、不命中任何數據，`$nin: []` reject)。同欄多個運算子為 AND。
- 文件層 `$and`、`$or`：值為條件物件之非空陣列，可巢狀。
- 欄名須符合 `^[\p{L}_][\p{L}\p{M}\p{N}_]*$`，長度不超過 128，且不為 `__proto__`；`'o.k'` 之點路徑不是欄名。
- 上限：巢狀深度 32、`$and`/`$or` 項數 1000、`$in`/`$nin` 項數 10000、節點總數 100000。

整批 reject：非條件物件之值(`null`、陣列、字串、數值、布林、函數、`Date`、`RegExp`、`Map`、`Set`、類別實例等)；白名單外之運算子(`$not $nor $regex $options $exists $where $expr $type $mod $elemMatch $size $all` 等)；欄位層 `$and/$or`；`undefined`、`NaN`、`Infinity`、無效 `Date`、年份小於 0 或大於 9999 之 `Date`(如 `new Date(8.64e15)`)、`BigInt`、函數、`Symbol`、`RegExp` 之值；陣列值或巢狀物件之等值；`$nin: []`、`$and: []`、`$or: []`、`$and`/`$or` 內之 `{}`、`{ 欄: {} }`；`$gt $gte $lt $lte $in $nin` 內之 `null`；Symbol 鍵、存取器、不可列舉鍵、稀疏陣列。

Date：本套件以 JSON 存值，Date 存入後為 ISO 字串(`toISOString()`)；條件內之 Date 於入口檢核之後、查詢之前轉為同一格式之 ISO 字串(只轉換檢核所回傳之複本，不改動呼叫端之物件)，故 `{ d: new Date(...) }`、`$gte`、`$in` 等皆可命中。注意 Date 條件等同於其 ISO 字串條件，以字串字典序比較：① 與字串型欄位亦會比較(`{ d: { $lt: new Date(...) } }` 可能命中 `d` 為字典序較小之字串的數據)，欄位混放 Date 與字串時請勿用 Date 條件刪除；② 字典序僅在 Date 介於西元 0000–9999 年時等於時間序(此範圍內 `toISOString()` 恆為 24 字元 `YYYY-MM-DDTHH:mm:ss.sssZ`；範圍外輸出 `+yyyyyy-`、`-yyyyyy-` 前綴，字典序與時間序顛倒)。

- **條件側 fail-closed**：條件內任何位置(欄位等值、`$eq $ne $gt $gte $lt $lte`、`$in $nin` 之元素、`$and`/`$or` 內)之 `Date` 年份小於 0 或大於 9999(如 `new Date(8.64e15)`、`new Date(-8.64e15)`、`-000001` 年、`+010000` 年)，`select` 與 `delAll` 皆整批 reject，訊息為 `invalid find: Date year is out of range 0000-9999 at [<路徑>]`(不回顯值)，於讀取之前 reject，不讀取、不刪除、不發出 `change` 事件。邊界 `0000-01-01T00:00:00.000Z` 與 `9999-12-31T23:59:59.999Z` 接受。此檢核屬本套件轉譯層(共用檢核 `cvOrmFind` 接受一切有效 `Date`)。例如修正前 `delAll({ t: { $gt: new Date(8.64e15) } })`(意為「晚於最大日期」，應無命中)會因字典序顛倒而刪除所有帶日期之數據，現改為 reject。
- **數據側**：寫入(`insert`、`insertBulk`、`save`)範圍外 `Date` 自 1.0.34 起整批 reject，見下節「寫入數據之 Date」。**資料庫內既有之範圍外 `Date` 字串(舊版存入者)仍無法以 `Date` 條件正確比較**：例如舊版以 `new Date(8.64e15)` 作「永不過期」哨兵存入之 `'+275760-…'`，範圍內之條件 `{ expireAt: { $lt: 現在 } }` 仍會因字典序命中哨兵(`'+275760-…' < '2026-…'`)，`delAll` 會將其刪除。此限制是雙向的：既可能誤命中(上例)，亦可能漏命中(例如 `{ t: { $gt: new Date('9999-12-31T23:59:59.999Z') } }` 不會命中 `'+275760-…'` 之資料)，範圍外資料彼此間的順序亦不可靠。請自行清理或改寫既有資料，清理方式見下節。

### 寫入數據之 Date (Date in written data)

自 1.0.34 起，`insert`、`insertBulk`、`save`(含自動插入、更新既有與合併)於寫入前檢核數據內**任何深度**(頂層欄位、巢狀物件、陣列內)之 `Date`：年份須介於 0000–9999(此範圍內序列化後恆為 24 字元 `YYYY-MM-DDTHH:mm:ss.sssZ`，字典序等於時間序)。年份小於 0 或大於 9999 者(如 `new Date(8.64e15)`、`new Date(-8.64e15)`、`-000001` 年、`+010000` 年)整批 reject(fail-closed，與條件側一致)：

- 訊息為 `invalid data: Date year is out of range 0000-9999 at [<路徑>]`，路徑形如 `data[0].expireAt`、`data[2].list[1].t`(輸入為單一物件時視為長度 1 之陣列；物件之鍵非一般識別字者以 `["a.b"]` 表示)，不回顯值。於 reject 之前發出一次 `error` 事件，不發出 `change` 事件。
- 整批中任一筆含範圍外 `Date` 即整批 reject，不寫入任何一筆，資料庫不變。`save` 即使因 `autoInsert: false` 而主鍵不存在(不會寫入)亦先經同一檢核。已關閉之實例仍先以已關閉訊息 reject；`autoGenPk: false` 而缺主鍵者仍先以缺主鍵訊息 reject。
- 邊界 `0000-01-01T00:00:00.000Z` 與 `9999-12-31T23:59:59.999Z` 接受。無效 `Date`(`Invalid Date`)處置不變，序列化為 `null` 存入。
- 只檢核 `Date` 物件，以 `JSON.stringify`(即實際寫入之序列化)之結果判定：已是字串者(如讀出後再存回之 `'+275760-09-13T00:00:00.000Z'`)、`Map`/`Set` 內之 `Date`(序列化為 `{}`)、非 `Date` 之 `toJSON` 物件(含 `Buffer`)之輸出皆不檢核；`TypedArray`、`DataView` 的自有屬性照常序列化，其內之 `Date` 會檢核。刻意構造之物件(自訂 `toJSON` 回傳含 `Date` 之物件、依屬性鍵或狀態回傳不同值之 `toJSON`、`Proxy` 包裝之 `Date`、`cloneDeep` 不複製之物件)不在檢核範圍。
- 原因：範圍外 `Date` 存為 `+yyyyyy-…`、`-yyyyyy-…` 字串後，字典序與時間序顛倒。例如以 `new Date(8.64e15)` 作「永不過期」哨兵，`delAll({ t: { $lt: new Date() } })` 會因字典序把它當成過去而刪除。「永不過期」請改用 `null`，或範圍內之 `new Date('9999-12-31T23:59:59.999Z')`(此二者不會被 `{ t: { $lt: 現在 } }` 命中，但仍會被 `$ne`、`$nin` 命中，依條件自行斟酌)。

**既有資料不遷移、不改讀取**：1.0.34 起寫入拒收，但資料庫內已存在之範圍外 `Date` 字串仍有字典序風險，請自行清理或改寫。例如 `let rows = (await wo.select()).filter((v) => /^[+-]\d{6}-/.test(v.t))` 找出欄位 `t` 為範圍外字串者(巢狀欄位同理自行走訪)，再 `for (let v of rows) { await wo.save({ id: v.id, t: null }) }` 或以範圍內之值覆寫。

語意為 MongoDB 式：`{ f: null }` 命中 `f` 為 `null` 或缺欄之數據，`$ne: x`(x 非 `null`)與 `$nin` 亦命中欄位為 `null` 或缺欄之數據，`$ne: null` 則排除之。欄名同於 `Object.prototype` 成員者(`constructor`、`toString`、`hasOwnProperty` 等)，數據無此自有欄位時視為缺欄。欄位值為陣列時，純量與 `$in` 條件仍以元素比對(`{ tags: 'x' }` 命中 `tags: ['x', 'y']`)。欲在 `w-orm-*` 各後端得到相同結果，請明確寫出：排除 null/缺欄用 `{ $and: [{ f: { $ne: null } }, { f: { $ne: x } }] }`，含 null/缺欄用 `{ $or: [{ f: null }, { f: { $ne: x } }] }`。

### 字串良構 (Well-formed strings)

JavaScript 字串可含孤立代理字元(lone surrogate，即成對代理被拆開後只剩一半，如 `'a\uD800'`，`isWellFormed()` 為 `false`)。level 之鍵經 UTF-8 編碼，孤立代理字元被改寫為 U+FFFD，使 `'a\uD800'`、`'a\uDC00'` 與 `'a�'` 落到**同一個鍵**：`insert` 誤判主鍵已存在、`save` 覆蓋他筆、`del` 誤刪他筆、`selectByPk` 取到他筆。本套件因此於任何讀取與寫入之前拒收，檢核為 `wsemi` 之 `chkOrmStr`、`chkOrmData`(w-orm 系列共用，各後端規則一致)：

- **主鍵 `id`**：不得含孤立代理字元，亦不得含 NUL 字元(U+0000)，與 `find` 同標準；不隨 `autoGenPk` 改變。
- **寫入資料**(`insert`、`insertBulk`、`save`)：任何字串值與鍵名(含巢狀物件、陣列元素、`Map`/`Set` 項目、`Error`/`RegExp` 之文字)不得含孤立代理字元；值與鍵名內之 NUL 不在此規則拒收範圍。level 以 JSON 存值，孤立代理字元本可保真，但全系列一律拒收，使同一應用更換後端時資料行為一致。
- **`opt.url`、`opt.db`、`opt.cl`**：含孤立代理字元者建構時 throw `invalid opt.<名>: string contains lone surrogate`(路徑經檔案系統改寫後，不同名稱會共用同一個資料夾)，不建立任何資料夾。
- U+FFFD 本身與成對代理(emoji、CJK 擴充 B 區以後之罕用字)為良構，照常接受。

拒收之處置與既有「無效主鍵」同形，訊息為固定詞彙、不回顯值：

| 呼叫 | 結果 |
|---|---|
| `insert`、`insertBulk` | 整批 reject，不寫入任何一筆；於 reject 之前發出一次 `error` 事件 |
| `save`、`del` | 該筆 `ok: 0` 附 `err`，同批其他筆照常處理 |
| `selectByPk` | 回傳 `null`(不 reject、不發事件) |
| `select`、`delAll` | 不變：`invalid find: <原因> at [<路徑>]` |

訊息為 `invalid id: <原因> at [data[<k>].id]` 與 `invalid data: <原因> at [data[<k>].<路徑>]`(`<k>` 為批次索引，單一物件呼叫為 `data[0]`；不合格之鍵名以 `<invalid key>` 表示)，`<原因>` 為 `string contains lone surrogate`、`string contains NUL`(僅主鍵)、`not a string` 或 `string is empty`(`del` 之 `id` 未給、非字串或空字串；取代原本回顯值之 `can not delete by invalid id[...]`)。同批以索引最小之不合格筆為準，同一筆內主鍵先於資料；與 Date 範圍檢核並存時，Date 範圍檢核先於良構檢核。

**既有資料不遷移、不改讀取**：本規則實施前以孤立代理字元為主鍵寫入者，其鍵已被改寫為 U+FFFD(與同形之 U+FFFD 主鍵為同一鍵)，值內之 `id` 欄仍保有孤立代理字元，`select` 仍讀得到。檢出：`(await wo.select()).filter((r) => typeof r.id === 'string' && !r.id.isWellFormed())`。清除：該列之真實鍵為 U+FFFD 同形字串，以 `await wo.del({ id: 同形字串 })`(把孤立代理字元換成 `'�'`)刪除，或依該列之其他欄位 `delAll({ 欄: 值 })`，或 `delAll()` 清空整表；以孤立 `id` 本身呼叫 `del`、`selectByPk` 已被拒，不會再誤中他筆。已存入之值內孤立代理字元仍保真，對該列未含該欄之 `save` 更新照常成功(只檢核本次寫入之內容，不連坐檢核既有內容)。**主鍵含 NUL 之舊列**(原可保真存入)亦不再可由主鍵定址(`selectByPk` 回 `null`、`del` 該筆 `ok: 0`)；其 `id` 為良構故上述 `isWellFormed` 檢出法不涵蓋，可改以 `r.id.includes('\u0000')` 檢出；因 `find` 亦拒 NUL，`delAll({ id })` 無法清除，須依該列之其他欄位 `delAll({ 欄: 值 })` 或 `delAll()`。

已知限制：`String` 包裝物件(`new String('...')`)僅檢核其字串值、不解包；`toJSON` 或自訂序列化之輸出不檢核。

### 診斷輸出 (Diagnostic output)

本套件唯一會自行輸出的情形，是 `change` 或 `error` 事件的訂閱函數拋錯時：錯誤被攔下(不影響該次操作的回傳，也不影響事件發出)並輸出一筆診斷。除此之外本套件不輸出任何東西(LevelDB 自身的 `LOG` 檔寫在資料庫資料夾內，不是 console，且不含資料值)。所有診斷輸出皆經單一出口 `src/getDiag.mjs`；選項名稱與 `w-serv-orm`、`w-orm-reladb` 相同，語意相同處為預設只輸出標籤與摘要、`logDetail` 還原細節、`funLog(label, safe, detail)` 取代 console 並收完整細節(遮罩拷貝)；差異處為選項型別錯誤的處置：本套件依自身慣例(同 `useCache`、`autoGenPk`)忽略並用預設，`w-serv-orm` 則 throw。

| 選項 | 說明 |
|---|---|
| `opt.logDetail` | 布林，預設 `false`。`true` 時還原為舊版輸出 `console.log(拋出值)`(含錯誤訊息與堆疊；單一引數、無標籤)，供除錯。輸出的是拋出值的遮罩拷貝(見下) |
| `opt.funLog` | 函數 `(label, safe, detail)`，預設無。給予時診斷輸出只交給它、不寫 console；`detail` 為訂閱函數拋出值的遮罩拷貝(含錯誤訊息；不是原參照，原地修改它不影響原物件，也不影響操作的回傳與事件參數)，供自行遮罩或轉送。與 `logDetail` 並給時以 `funLog` 為準。`funLog` 拋錯或回傳被 reject 的 promise 皆被吞下，不影響操作 |

兩個選項於建構時取固定快照；型別錯誤(`logDetail` 非布林 `true`、`funLog` 非函數)或讀取該選項時拋錯者，忽略並用預設、不 throw(同 `useCache`、`autoGenPk` 型別錯誤即用預設)。

預設輸出只含固定標籤與摘要：

```js
// 訂閱函數 wo.on('change', () => { throw new Error('... u-secret-001 ...') }) 拋錯時
// 預設:
change handler threw { mode: 'insert', errType: 'Error' }
// error 事件之訂閱函數拋錯時: error handler threw { mode: 'insert', errType: 'Error' }
```

- `mode`：操作別。`errType`：拋出值的型別(`string`、`number`、`undefined`、`null`、`object`、`function`…)；拋出值為原生 `Error` 時為其建構子名稱(沿原型鏈取第一個資料屬性 `constructor` 的 `name`，限 `^[A-Za-z][A-Za-z0-9_]{0,39}$`，不合者——如 `_` 或 `$` 開頭、超過 40 字元、含連字號——列為 `Error`)；偵測得到 `Proxy` 者(Node 的 `util.types`)列為 `Proxy` 且不讀取其任何屬性。`errCode`：僅當拋出值的**自有資料屬性** `code` 為機器代碼(`ENOENT` 類 E 開頭純大寫字母、`E2BIG`、`ERR_xxx`、`LEVEL_xxx`、絕對值至 99999 的整數)時列出(一般物件與函數若帶此 `code` 亦同)。
- 不含資料值、主鍵、使用者識別、錯誤訊息、堆疊與路徑；摘要與拷貝皆不執行拋出值上的存取器。
- **資料庫位置視同連線字串**：`opt.url`、`opt.db`、`opt.cl` 組成的儲存位址(及其絕對路徑、正反斜線形式)與 `opt.url`，不進預設輸出(預設不含細節)；`logDetail` 與 `funLog` 的細節中若出現(例如後端 I/O 錯誤訊息 `IO error: <位址>/000005.ldb` 經訂閱函數轉拋)，屬性值、屬性鍵、Symbol 描述與堆疊內的該段皆以 `***` 取代。`db`、`cl` 單獨(如 `worm`、`test`)與短於 3 字元或全為路徑符號的 `url`(如 `.`)不單獨遮罩。本套件沒有帳密選項。建構函式拋出的訊息(`invalid opt.url: string contains lone surrogate` 等)為固定詞彙，不回顯值。
- 遮罩拷貝：純物件、類別實例、陣列、`Error`(含 `message`、`stack`、`cause`、`name`)、`Date` 複製為內建原型的副本；函數、`Proxy`、二進位資料、`Map`、`Set`、`RegExp`、存取器以標記字串代替，深度超過 8 或節點超過 5000 者以 `[Truncated]` 代替；子類別 `Error` 的類別名稱以其 `name` 屬性為準(僅 `class X extends Error {}` 而未設 `name` 者輸出為 `Error`)。
- 診斷輸出自身拋錯被吞下，不使操作拋錯：取細節拋錯時改傳 `(unprintable)`；`console.log` 拋錯時改輸出 `console.log(標籤, '(unprintable)')`，再拋則放棄。
- `resolve`／`reject` 的內容、事件參數與發出時機不受任何診斷選項影響。各操作的 `reject`、逐筆 `err` 欄位與 `error` 事件內的訊息文字(如 `can not insertBulk by existed id[<id>]`、後端 I/O 錯誤原文)屬回傳契約，不在診斷輸出範圍。
- 限制：不靜態引入 Node 內建模組(UMD 打包)，`util.types` 於執行期以 `process.getBuiltinModule('util')` 取得；取不到(非 Node 或舊版 Node)時無法偵測 `Proxy`、跨 realm 的 `Error` 列為 `object`，`Proxy` 的 trap 屬使用端程式，其拋錯被吞下。`errType`、`errCode` 的樣式白名單不能證明名稱或代碼不含個資(類別名與機器代碼為程式識別字)。

要取得舊版的完整輸出：

```js
let wo = WOrm({ url: './_db', db: 'worm', cl: 'users', logDetail: true })
// 或交給自己的紀錄函式
let wo2 = WOrm({ url: './_db', db: 'worm', cl: 'users', funLog: (label, safe, detail) => { /* 自行遮罩後寫入 */ } })
```

### 破壞性變更 (Breaking changes)

原本被接受或被靜默放行之條件，現改為 reject，不設過渡期。

- 移除：白名單以外之全部 `mingo` 運算子(`$not $nor $regex $options $exists $type $mod $elemMatch $size $all $expr $where $bitsAllSet` 等)；`RegExp` 值(`{ name: /x/i }`、`$in: [/x/]`)；陣列字面值之等值、巢狀物件等值(`{ tags: ['x', 'y'] }`、`{ o: { k: 1 } }`)與 `$elemMatch`、`$all`、`$size`(欄位值為陣列時，純量與 `$in` 條件之元素比對語意仍保留)；點路徑(`{ 'o.k': 1 }`)。需要時請 `select()` 後於記憶體過濾。
- 改為 reject(原本靜默放行)：不是條件物件之 `find`(`null`、`[]`、`'x'`、`123`、`true`、函數、`Date`、`Map`、`Set`、僅含 Symbol 鍵之物件、條件在原型上之物件)，原本 `select(find)` 回傳全部數據、`delAll(find)` 刪除全部數據(帶自有鍵之類別實例原本即由 `mingo` 拒收，訊息為 `query criteria must be an object`，現統一為 `invalid find`)；`undefined` 值(`{ age: undefined }`、`$eq: undefined` 原本命中欄位為 null 或缺欄之數據，`$in: [undefined]` 原本無命中，稀疏陣列之洞原被當缺欄)；`NaN`、`Infinity`、函數、`Symbol` 之值；`$nin: []`、`$and: []`、`$or: []`、`$and: [{}]`、`$or: [{}]`、`{ age: {} }`；不合文法之欄名、存取器與不可列舉鍵；巢狀深度超過 32、`$in` 超過 10000 項。
- 新行為：條件內之 Date 可命中(原本因數據為 ISO 字串而條件為 Date，`$eq`、`$gt`、`$gte`、`$lt`、`$lte`、`$in` 恆不命中，`$ne`、`$nin` 恆命中，`delAll` 因而可能刪除全部)；Date 範圍比較之限制見上。
- 改為 reject(Date 範圍)：條件內任何位置之 `Date` 年份小於 0 或大於 9999(如 `new Date(8.64e15)`)，原本轉為帶正負號之 ISO 字串後以字典序比較，結果與時間序顛倒(`$gt` 哨兵命中所有帶日期之數據、`$lt` 哨兵恆無命中)，現整批 reject；數據側見下一條。
- 改為 reject(寫入 Date 範圍，1.0.34 起)：`insert`、`insertBulk`、`save` 寫入之數據內任何深度之 `Date` 年份小於 0 或大於 9999(如以 `new Date(8.64e15)` 作「永不過期」哨兵)，原本照存為 `+yyyyyy-…`、`-yyyyyy-…` 字串(其後會被 `{ t: { $lt: 現在 } }` 因字典序命中而遭 `delAll` 刪除)，現整批 reject，訊息為 `invalid data: Date year is out of range 0000-9999 at [<路徑>]`；請改用 `null` 或 `new Date('9999-12-31T23:59:59.999Z')`。既有資料不遷移，仍有字典序風險，請自行清理或改寫(見上方「寫入數據之 Date」)。
- 錯誤訊息為 `invalid find: <原因> at [<路徑>]`；原本由 `mingo` 拋出錯誤者，現統一為此訊息。
- 改為 reject(字串良構)：主鍵含孤立代理字元或 NUL；寫入資料之字串值或鍵名含孤立代理字元；`opt.url`、`opt.db`、`opt.cl` 含孤立代理字元(建構時 throw)。原本主鍵之孤立代理字元被 UTF-8 改寫為 U+FFFD 而與他筆相撞(覆蓋、誤刪、誤命中)，值內孤立代理字元原照存，現皆拒收，見上節「字串良構」。`del` 未給有效 `id` 之 `err` 由 `can not delete by invalid id[<值>]` 改為 `invalid id: <原因> at [data[<k>].id]`(不回顯值)。
- 診斷輸出預設變動：`change`／`error` 事件的訂閱函數拋錯時，原本 `console.log(拋出值)`(含錯誤訊息與堆疊，訊息可能夾帶資料值或主鍵)，現預設只輸出 `change handler threw { mode, errType }` 或 `error handler threw { mode, errType }`(`errType` 為拋出值的型別或錯誤類別名稱，另有機器代碼時列 `errCode`)；`logDetail`／`funLog` 的細節為遮罩拷貝(資料庫位置以 `***` 取代)。要取得舊版輸出請於建構時加 `logDetail: true`，或以 `funLog(label, safe, detail)` 接收完整細節；回傳(`resolve`／`reject` 內容)、事件參數與發出時機不變。見上節「診斷輸出」。
- 修正(主鍵為 `Object.prototype` 成員名)：主鍵為 `constructor`、`toString`、`valueOf`、`hasOwnProperty`、`__proto__` 等時，原本 `insert` 回 `{ n: 1, nInserted: 0, ok: 1 }` 而靜默不寫入，`insertBulk` 誤報 `can not insertBulk by existed id[...]`，`save` 回 `nModified: 1`(實為新增)，`del` 回 `nDeleted: 1`(實未刪除任何一列)；以 `__proto__` 為主鍵之紀錄其欄位名還會被誤認為其他主鍵(同批之後筆被判已存在，`save` 時以該欄位值為現值合併而寫入損毀之紀錄)；現主鍵存在與否以 `Map` 判定，與一般字串主鍵行為相同。

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-orm-level/WOrm.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-orm-level
```

#### Example for collection
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-orm-level/blob/master/g-basic.mjs)]
```alias
import WOrm from './src/WOrmLevel.mjs'
//import WOrm from './dist/w-orm-level.umd.js'
// import w from 'wsemi'

// w.fsDeleteFolder('./_db')

let opt = {
    url: './_db',
    db: 'worm',
    cl: 'users',
}

let rs = [
    {
        id: 'id-peter',
        name: 'peter',
        value: 123,
    },
    {
        id: 'id-rosemary',
        name: 'rosemary',
        value: 123.456,
    },
    {
        id: '',
        name: 'kettle',
        value: 456,
    },
]

let rsm = [
    {
        id: 'id-peter',
        name: 'peter(modify)'
    },
    {
        id: 'id-rosemary',
        name: 'rosemary(modify)'
    },
    {
        id: '',
        name: 'kettle(modify)'
    },
]

let rsa = [
    {
        id: 'id-rosemary',
        name: 'rosemary',
        value: 654.321,
    },
]

async function test() {

    //wo
    let wo = WOrm(opt)

    //on
    wo.on('change', function(mode, data, res) {
        console.log('change', mode)
    })
    wo.on('error', function(mode, data, err) {
        console.log('error', mode, err)
    })

    //delAll
    await wo.delAll()
        .then(function(msg) {
            console.log('delAll then', msg)
        })
        .catch(function(msg) {
            console.log('delAll catch', msg)
        })

    //insert
    await wo.insert(rs)
        .then(function(msg) {
            console.log('insert then', msg)
        })
        .catch(function(msg) {
            console.log('insert catch', msg)
        })

    //insert by returnList, 回傳與輸入等長保序之逐筆結果, nInserted為1即該筆為新增
    await wo.insert([{ id: 'id-peter' }, { id: 'id-new' }], { returnList: true })
        .then(function(msg) {
            console.log('insert(returnList) then', msg)
        })
        .catch(function(msg) {
            console.log('insert(returnList) catch', msg)
        })

    //insertBulk, 全有全無, 任一筆主鍵已存在即整批reject且不寫入任何一筆
    await wo.insertBulk([{ id: 'id-bulk1' }, { id: 'id-bulk2' }])
        .then(function(msg) {
            console.log('insertBulk then', msg)
        })
        .catch(function(msg) {
            console.log('insertBulk catch', msg.toString())
        })

    //insertBulk by existed id
    await wo.insertBulk([{ id: 'id-bulk3' }, { id: 'id-peter' }])
        .then(function(msg) {
            console.log('insertBulk(existed) then', msg)
        })
        .catch(function(msg) {
            console.log('insertBulk(existed) catch', msg.toString())
        })

    //save
    await wo.save(rsm, { autoInsert: false })
        .then(function(msg) {
            console.log('save then', msg)
        })
        .catch(function(msg) {
            console.log('save catch', msg)
        })

    //selectByPk
    let sp = await wo.selectByPk('id-rosemary')
    console.log('selectByPk', sp)

    //selectByPk by non-existed id
    let spn = await wo.selectByPk('id-non-existed')
    console.log('selectByPk(non-existed)', spn)

    //del by id-new, id-bulk1, id-bulk2
    await wo.del([{ id: 'id-new' }, { id: 'id-bulk1' }, { id: 'id-bulk2' }])
        .then(function(msg) {
            console.log('del(clean) then', msg)
        })
        .catch(function(msg) {
            console.log('del(clean) catch', msg)
        })

    //select all
    let ss = await wo.select()
    console.log('select all', ss)

    //select
    let so = await wo.select({ id: 'id-rosemary' })
    console.log('select', so)

    //select by $and, $gt, $lt
    let spa = await wo.select({ '$and': [{ value: { '$gt': 123 } }, { value: { '$lt': 200 } }] })
    console.log('select by $and, $gt, $lt', spa)

    //select by $or, $gte, $lte
    let spb = await wo.select({ '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 200 } }] })
    console.log('select by $or, $gte, $lte', spb)

    //select by $or, $and, $ne, $in, $nin
    let spc = await wo.select({ '$or': [{ '$and': [{ value: { '$ne': 123 } }, { value: { '$in': [123, 321, 123.456, 456] } }, { value: { '$nin': [456, 654] } }] }, { '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 400 } }] }] })
    console.log('select by $or, $and, $ne, $in, $nin', spc)

    // //select by regex //系列條件白名單不支援$regex(含$options), 會整批reject(invalid find: unsupported operator), 須改為select後自行過濾
    // let sr = await wo.select({ name: { $regex: 'PeT', $options: '$i' } })
    // console.log('selectReg', sr)

    //save
    await wo.save(rsa, { autoInsert: true })
        .then(function(msg) {
            console.log('save then', msg)
        })
        .catch(function(msg) {
            console.log('save catch', msg)
        })

    //del
    let d = ss.filter(function(v) {
        return v.name === 'kettle'
    })
    await wo.del(d)
        .then(function(msg) {
            console.log('del then', msg)
        })
        .catch(function(msg) {
            console.log('del catch', msg)
        })

    //del by invalid id, 未帶有效主鍵者為該筆ok為0並附err, 整批仍resolve
    await wo.del([{ name: 'no-id' }])
        .then(function(msg) {
            console.log('del(invalid id) then', msg)
        })
        .catch(function(msg) {
            console.log('del(invalid id) catch', msg)
        })

    //delAll by find
    await wo.delAll({ value: { '$gte': 600 } })
        .then(function(msg) {
            console.log('delAll(find) then', msg)
        })
        .catch(function(msg) {
            console.log('delAll(find) catch', msg)
        })

    //close, level對資料庫目錄為獨佔鎖, 用畢須關閉方能令該目錄再被開啟
    await wo.close()

}
test()
// change delAll
// delAll then { n: 0, nDeleted: 0, ok: 1 }
// change insert
// insert then { n: 3, nInserted: 3, ok: 1 }
// change insert
// insert(returnList) then [ { n: 1, nInserted: 0, ok: 1 }, { n: 1, nInserted: 1, ok: 1 } ]
// change insertBulk
// insertBulk then { n: 2, nInserted: 2, ok: 1 }
// error insertBulk can not insertBulk by existed id[id-peter]
// insertBulk(existed) catch Error: can not insertBulk by existed id[id-peter]
// change save
// save then [
//   { n: 1, nInserted: 0, nModified: 1, ok: 1 },
//   { n: 1, nInserted: 0, nModified: 1, ok: 1 },
//   { n: 0, nInserted: 0, nModified: 0, ok: 1 }
// ]
// selectByPk { id: 'id-rosemary', name: 'rosemary(modify)', value: 123.456 }
// selectByPk(non-existed) null
// change del
// del(clean) then [
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 },
//   { n: 1, nDeleted: 1, ok: 1 }
// ]
// select all [
//   {
//     id: {random id},
//     name: 'kettle',
//     value: 456
//   },
//   { id: 'id-peter', name: 'peter(modify)', value: 123 },
//   { id: 'id-rosemary', name: 'rosemary(modify)', value: 123.456 }
// ]
// select [ { id: 'id-rosemary', name: 'rosemary(modify)', value: 123.456 } ]
// select by $and, $gt, $lt [ { id: 'id-rosemary', name: 'rosemary(modify)', value: 123.456 } ]
// select by $or, $gte, $lte [
//   {
//     id: {random id},
//     name: 'kettle',
//     value: 456
//   }
// ]
// select by $or, $and, $ne, $in, $nin [
//   {
//     id: {random id},
//     name: 'kettle',
//     value: 456
//   },
//   { id: 'id-rosemary', name: 'rosemary(modify)', value: 123.456 }
// ]
// change save
// save then [ { n: 1, nInserted: 0, nModified: 1, ok: 1 } ]
// change del
// del then [ { n: 1, nDeleted: 1, ok: 1 } ]
// error del invalid id: not a string at [data[0].id]
// change del
// del(invalid id) then [ { n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' } ]
// change delAll
// delAll(find) then { n: 1, nDeleted: 1, ok: 1 }
```
