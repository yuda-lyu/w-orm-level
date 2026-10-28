//診斷輸出之單一出口(R-DIAG-01): src內所有console輸出皆經getDiag回傳之diag, 除本檔外不得直接呼叫console
//預設只輸出固定標籤與不含個資之摘要(不含資料值、id、使用者識別、後端或使用端錯誤原文、路徑); 選項名稱與語意比照w-serv-orm: opt.logDetail(還原細節輸出)、opt.funLog(label, safe, detail)(取代console收完整細節)
//本套件無連線憑證(opt僅url〔本機資料夾〕、db、cl、useCache、autoGenPk): 資料庫位置(url、db、cl組成之儲存位址, 及其絕對路徑與正反斜線形式)視同連線字串, 於細節(logDetail與funLog)以***遮罩, 預設輸出不含細節
//不靜態import Node內建模組(util等): dist由rollup打包(UMD), gDistRollup.mjs之external只列level、mingo; 需要util.types時於執行期以process.getBuiltinModule取得, 取不到(非Node或舊版Node)則退回不依賴它的判定
import get from 'lodash-es/get.js'


//遮罩字串
const MASK = '***'

//cpMask之上限: 深度, 處理的節點與鍵合計數; 超過者以標記字串代替(不交出原參照)
const CP_DEPTH = 8
const CP_MAX = 5000

//原型鏈走訪層數上限(含自訂getPrototypeOf的Proxy在內, 不使走訪無窮)
const MAX_PROTO = 32

//錯誤類別名稱的白名單樣式: 只放行建構子名稱(程式識別字), 其餘(可能夾帶資料值之文字)不進預設輸出
const RE_ERR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

//錯誤代碼的白名單樣式: 系統與資料庫慣用之機器代碼(ENOENT、E2BIG、ERR_xxx、LEVEL_xxx); E開頭者除E2BIG外限純大寫字母(排除E123456789、EMP00123類識別碼); 整數另行判斷
const RE_ERR_CODE = /^(E2BIG|E[A-Z]{2,15}|ERR_[A-Z0-9_]{1,40}|LEVEL_[A-Z0-9_]{1,40})$/

//Error的stack於V8為自有存取器, 其getter為同一realm內共用的內建函數: 僅當描述子的getter與此相同才讀取(不執行使用端程式)
const STACK_GETTER = (() => {
    try {
        let d = Object.getOwnPropertyDescriptor(new Error(), 'stack')
        return d !== undefined && !Object.prototype.hasOwnProperty.call(d, 'value') && typeof d.get === 'function' ? d.get : null
    }
    catch (e) {
        return null
    }
})()


function mkTypes(t) {
    //util.types之子集(isProxy、isNativeError、isPromise): 有內建者用之, 否則退回不依賴它的判定(無法偵測Proxy; 跨realm的Error與Promise不認得)
    let has = (k) => t !== null && t !== undefined && typeof t[k] === 'function'
    return {
        isProxy: has('isProxy') ? (v) => t.isProxy(v) : () => false,
        isNativeError: has('isNativeError') ? (v) => t.isNativeError(v) : (v) => v instanceof Error,
        isPromise: has('isPromise') ? (v) => t.isPromise(v) : (v) => v instanceof Promise,
    }
}


//TYPES, 執行期取得之util.types(不靜態import: UMD打包與非Node環境)
const TYPES = (() => {
    try {
        let u = globalThis.process.getBuiltinModule('util')
        return mkTypes(u.types)
    }
    catch (e) {
        return mkTypes(null)
    }
})()


function getOptLog(opt) {
    //診斷輸出的設定, 供WOrmLevel建構時使用, 回傳固定快照{ logDetail, funLog }, 其後各路徑共用此快照, 不再讀取使用端的opt
    //型別錯誤者忽略並用預設(安全輸出), 讀取opt拋錯者亦同, 與本套件其他選項(useCache、autoGenPk等型別錯誤即用預設)一致; 各選項分別讀取, 單一getter拋錯只丟該選項
    //logDetail: 須為true才生效, 預設false; true時console輸出還原為含錯誤原文的完整細節(舊版輸出; 位址名稱遮罩), 供除錯
    //funLog: 須為函數才生效, 預設無; 給予時診斷輸出只交給它(不寫console), detail為完整細節(位址名稱遮罩之拷貝), 供使用端遮罩或轉送
    let logDetail = false
    try {
        logDetail = get(opt, 'logDetail') === true
    }
    catch (e) {
        //忽略
    }
    let funLog = null
    try {
        let f = get(opt, 'funLog')
        funLog = typeof f === 'function' ? f : null
    }
    catch (e) {
        //忽略
    }
    return { logDetail, funLog }
}


function isUsable(s) {
    //可列入遮罩清單的字串: 非空, 至少3字元, 且不全為路徑符號(如'.'、'./'會吞掉大量無關文字)
    return typeof s === 'string' && s.length >= 3 && /[^./\\\s]/.test(s)
}


function resolveAbs(cwd, s) {
    //以cwd解析相對路徑s(僅處理.與..段, 正斜線輸出), 供遮罩清單列入絕對路徑形式; s已為絕對路徑(磁碟機代號或根)者回傳null
    if (/^([A-Za-z]:)?[\\/]/.test(s)) {
        return null
    }
    let segs = cwd.replace(/\\/g, '/').split('/')
    for (let seg of s.replace(/\\/g, '/').split('/')) {
        if (seg === '' || seg === '.') {
            continue
        }
        if (seg === '..') {
            if (segs.length > 1) {
                segs.pop()
            }
            continue
        }
        segs.push(seg)
    }
    return segs.join('/')
}


function getSecrets(url, db, cl) {
    //資料庫位置的遮罩清單: 儲存位址(`${url}/${db}/${cl}`, 即傳給Level者)與url, 各取原樣、反斜線形式、以目前工作目錄解析之絕對路徑(正反斜線形式); 長者在前, 使長字串先被遮罩
    //註: db與cl單獨不列入(如worm、test之類常用字會吞掉大量無關文字); url短於3字元或全為路徑符號者不單獨列入
    let cwd = ''
    try {
        cwd = String(globalThis.process.cwd())
    }
    catch (e) {
        //非Node環境無cwd, 略過絕對路徑形式
    }
    let all = []
    for (let s of [`${url}/${db}/${cl}`, url]) {
        if (!isUsable(s)) {
            continue
        }
        all.push(s, s.replace(/\//g, '\\'))
        if (cwd !== '') {
            let abs = resolveAbs(cwd, s)
            if (abs !== null) {
                all.push(abs, abs.replace(/\//g, '\\'))
            }
        }
    }
    return all.filter((s, k) => isUsable(s) && all.indexOf(s) === k).sort((a, b) => b.length - a.length)
}


function maskText(s, secrets) {
    //字串中之遮罩清單項目以***取代
    if (typeof s !== 'string') {
        return s
    }
    let r = s
    for (let sec of secrets) {
        if (r.indexOf(sec) >= 0) {
            r = r.split(sec).join(MASK)
        }
    }
    return r
}


function maskKey(k, secrets) {
    //屬性鍵之遮罩: 字串鍵與Symbol之描述文字皆可能含位址
    if (typeof k === 'string') {
        return maskText(k, secrets)
    }
    let d = k.description
    let m = typeof d === 'string' ? maskText(d, secrets) : d
    return m === d ? k : Symbol(m)
}


function readData(o, k, T) {
    //取o(含原型鏈, 至多MAX_PROTO層)上資料屬性k之值, 不執行getter、不觸發Proxy陷阱(遇Proxy即止); 自有屬性遮蔽者以遮蔽層為準(非資料屬性則undefined); 無則undefined
    let x = o
    for (let i = 0; x !== null && x !== undefined && i < MAX_PROTO && !T.isProxy(x); i++) {
        let d = Object.getOwnPropertyDescriptor(x, k)
        if (d !== undefined) {
            return Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : undefined
        }
        x = Object.getPrototypeOf(x)
    }
    return undefined
}


function cp(v, c, depth) {
    //遞迴複製並遮罩, 不執行使用端程式(不呼叫getter、實例方法、建構子), 不交出原參照; 副本原型一律為內建原型(不沿用使用端的原型: 其繼承屬性未遮罩、util.inspect.custom會在格式化時執行)
    if (typeof v === 'string') {
        return maskText(v, c.secrets)
    }
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
        return v
    }
    if (typeof v === 'function') {
        return '[Function]'
    }
    if (depth >= CP_DEPTH || c.n >= CP_MAX) {
        return '[Truncated]'
    }
    if (c.seen.has(v)) {
        return c.seen.get(v)
    }
    c.n++
    try {
        if (c.T.isProxy(v)) {
            return '[Proxy]'
        }
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
            return `[Binary ${v.byteLength} bytes]`
        }
        if (v instanceof Date) {
            return new Date(Date.prototype.getTime.call(v))
        }
        if (v instanceof Map || v instanceof Set || v instanceof WeakMap || v instanceof WeakSet || v instanceof RegExp || v instanceof Promise) {
            return '[Object]' //無法複製的內建物件
        }
        let isArr = Array.isArray(v)
        let isErr = c.T.isNativeError(v)
        let r = isArr ? new Array(v.length) : (isErr ? new Error() : {})
        c.seen.set(v, r)
        for (let k of Reflect.ownKeys(v)) {
            if (c.n >= CP_MAX) {
                break
            }
            if (k === 'length' && isArr) {
                continue
            }
            let d = Object.getOwnPropertyDescriptor(v, k)
            if (d === undefined) {
                continue
            }
            c.n++
            let val = '[Getter/Setter]'
            if (Object.prototype.hasOwnProperty.call(d, 'value')) {
                val = cp(d.value, c, depth + 1)
            }
            else if (isErr && k === 'stack' && STACK_GETTER !== null && d.get === STACK_GETTER) {
                //stack於V8為內建存取器: 僅當其getter嚴格等於同realm共用之內建getter才讀取(不執行使用端程式)
                let s = STACK_GETTER.call(v)
                val = typeof s === 'string' ? maskText(s, c.secrets) : val
            }
            Object.defineProperty(r, isArr ? k : maskKey(k, c.secrets), { value: val, writable: true, enumerable: d.enumerable, configurable: true })
        }
        if (isErr && !Object.prototype.hasOwnProperty.call(r, 'name')) {
            //類別名稱常在原型上(class MyError extends Error): 取原型鏈上第一個資料屬性name, 副本才保有類別名稱
            let nm = readData(Object.getPrototypeOf(v), 'name', c.T)
            if (typeof nm === 'string') {
                Object.defineProperty(r, 'name', { value: maskText(nm, c.secrets), writable: true, enumerable: false, configurable: true })
            }
        }
        return r
    }
    catch (e) {
        return '[Uncopyable]'
    }
}


function cpMask(v, secrets = [], T = TYPES) {
    //交給console或funLog之完整細節的遮罩拷貝: 位址名稱以***取代(值、屬性鍵、Symbol描述), 不改動呼叫端的原物件(細節若與其後仍要使用的物件共用, 使用端原地遮罩會改變結果)
    //複製: 純物件與類別實例(複製自有屬性成普通物件, 不保留原型)、陣列、原生Error(含message、stack、cause、類別名稱name)、Date; 標記字串代替: 函數、Proxy、二進位資料、Map與Set等內建物件、存取器、過深(CP_DEPTH)或過大(CP_MAX)者
    return cp(v, { secrets, T, n: 0, seen: new WeakMap() }, 0)
}


function noop() {
    //吞下funLog回傳之promise的reject
}


function swallow(r, T = TYPES) {
    //funLog的回傳若為promise或thenable, 附上reject處理, 使其reject不成為unhandledRejection; 全程不使診斷輸出拋錯
    //原生promise用內建then(不讀其可被覆寫的then屬性); 其他thenable只讀一次then並以其為this呼叫, 回傳之原生promise亦附處理
    try {
        if (T.isPromise(r)) {
            Promise.prototype.then.call(r, undefined, noop)
            return
        }
        if (r !== null && (typeof r === 'object' || typeof r === 'function')) {
            let t = r.then
            if (typeof t === 'function') {
                let x = t.call(r, undefined, noop)
                if (T.isPromise(x)) {
                    Promise.prototype.then.call(x, undefined, noop)
                }
                else if (x !== null && (typeof x === 'object' || typeof x === 'function')) {
                    let xt = x.then
                    if (typeof xt === 'function') {
                        xt.call(x, undefined, noop)
                    }
                }
            }
        }
    }
    catch (e) {
        //放棄
    }
}


function getDiag(optLog, secrets = [], T = TYPES) {
    //回傳診斷輸出函數diag(label, safe, getDetail, bare), 所有診斷輸出皆經此(R-DIAG-01)
    //label: 固定標籤; safe: 不含資料值、id、錯誤原文與路徑的摘要(預設輸出), 無則undefined; getDetail: 回傳完整細節的函數(只在有消費者時才呼叫), 無細節則undefined
    //bare: 為true者, logDetail還原時只輸出細節而不加label(舊版該站即為console.log(細節))
    //secrets: 細節中須遮罩的字串清單(getSecrets); 細節交出前一律經cpMask拷貝, 不交出呼叫端的原參照
    //輸出不得使呼叫端的流程拋錯: 細節的取得、console與funLog的拋錯一律吞下; funLog回傳的promise之reject亦吞下
    //optLog經getOptLog正規化(未給、null或未包裝之物件皆可), 使欄位恆為{ logDetail: 布林, funLog: 函數或null }
    let { logDetail, funLog } = getOptLog(optLog)
    return (label, safe, getDetail, bare = false) => {

        //getArgs, 完整細節(遮罩拷貝); 僅在需要時取得
        let getArgs = () => {
            if (getDetail === undefined) {
                return []
            }
            try {
                return [cpMask(getDetail(), secrets, T)]
            }
            catch (e) {
                return ['(unprintable)']
            }
        }

        //funLog, 取代console輸出
        if (funLog !== null) {
            try {
                swallow(funLog(label, safe, ...getArgs()), T)
            }
            catch (e) {
                //放棄輸出
            }
            return
        }

        //console, 預設為安全摘要; logDetail為true時還原完整細節
        try {
            if (logDetail) {
                console.log(...(bare ? [] : [label]), ...getArgs())
            }
            else if (safe === undefined) {
                console.log(label)
            }
            else {
                console.log(label, safe)
            }
        }
        catch (e) {
            try {
                console.log(label, '(unprintable)')
            }
            catch (e2) {
                //放棄輸出
            }
        }
    }
}


function ownData(o, k) {
    //取o自有資料屬性k之值, 不執行getter; 非資料屬性或無則undefined
    try {
        if (o === null || (typeof o !== 'object' && typeof o !== 'function')) {
            return undefined
        }
        let d = Object.getOwnPropertyDescriptor(o, k)
        return d !== undefined && Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : undefined
    }
    catch (e) {
        return undefined
    }
}


function isErrCode(c) {
    //錯誤代碼是否為機器代碼: 絕對值至99999之整數, 或E開頭純大寫字母(ENOENT類)、E2BIG、ERR_開頭、LEVEL_開頭之字串
    if (typeof c === 'number') {
        return Number.isInteger(c) && Math.abs(c) <= 99999
    }
    return typeof c === 'string' && RE_ERR_CODE.test(c)
}


function getBriefErr(e, T = TYPES) {
    //錯誤(訂閱函數拋出的值)的摘要: 只列類別與代碼, 不含訊息文字; 全程不執行getter(只讀描述子的value), 偵測得到Proxy者(Node的util.types)不讀任何屬性
    //字串列為string; 原生Error取其建構子名稱(沿原型鏈第一個資料屬性constructor之name, 同w-serv-orm的readData), 不合識別字樣式者列為Error; 代碼取自有資料屬性code, 限機器代碼樣式
    try {
        if (typeof e === 'string') {
            return { errType: 'string' }
        }
        if (e === null || (typeof e !== 'object' && typeof e !== 'function')) {
            return { errType: e === null ? 'null' : typeof e }
        }
        if (T.isProxy(e)) {
            return { errType: 'Proxy' }
        }
        let r = { errType: typeof e === 'function' ? 'function' : 'object' }
        if (T.isNativeError(e)) { //不用Object.prototype.toString(會執行Symbol.toStringTag之getter)
            let ctor = readData(e, 'constructor', T)
            let cname = typeof ctor === 'function' && !T.isProxy(ctor) ? readData(ctor, 'name', T) : undefined
            r.errType = typeof cname === 'string' && RE_ERR_TYPE.test(cname) ? cname : 'Error'
        }
        let c = ownData(e, 'code')
        if (isErrCode(c)) {
            r.errCode = c
        }
        return r
    }
    catch (e2) {
        return { errType: 'unknown' }
    }
}


export { getOptLog, getSecrets, maskText, cpMask, mkTypes, TYPES, getDiag, getBriefErr }
