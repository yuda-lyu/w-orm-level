import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { inspect } from 'util'
import { Level } from 'level'
import diagCases from 'wsemi/src/_diagCases.mjs'
import WOrm from '../src/WOrmLevel.mjs'


//診斷輸出與遮罩之接線測試(帳本R-DIAG-01, 規格〈診斷輸出與遮罩〉D3、Q3、P1): 真LevelDB, 確認本套件之每個站點確實接上wsemi之共用實作
//遮罩與摘要之形態測試在wsemi(共用語料_diagCases), 此處以語料之wire案經本套件之真實呼叫點重跑, 並測本套件自身之處置:
//1. 含憑證之外來值(後端、使用端存取器與回呼拋出者): reject、error事件、逐筆err皆已遮(diag.err/diag.mask); 不含憑證者原物件交出(身分不變)
//2. 套件自身以固定詞彙組成之reject原樣(即使回顯之使用端值形似憑證, 固定字串挖空可反推秘密, D3)
//3. 儲存路徑: 診斷輸出(細節)遮, 對外錯誤值不遮(Q3)
//4. 診斷出口level(stdout/stderr)
//後端無法自然產生含憑證之錯誤, 故以Level.prototype上之方法暫時換成拋錯函數作為後端接縫(被測物是本套件之catch站點, 不是後端), 每次測完還原


let { cases, mkCtx, collect } = diagCases

let dirTest = path.dirname(fileURLToPath(import.meta.url))

//dirBase, 本檔專用之臨時資料夾(test/_tmp/<案名>, 由after刪除)
let dirBase = './test/_tmp/diagwire'
let n = 0
let nextUrl = () => `${dirBase}/d${n++}`

//opened, 本檔建立之全部實例(after一律關閉, 釋放LevelDB目錄鎖)
let opened = []
let mkWo = (extra = {}) => {
    let url = nextUrl()
    let wo = WOrm({ url, db: 'worm', cl: 'users', ...extra })
    opened.push(wo)
    return { wo, url, storage: `${url}/worm/users` }
}

//憑證與其遮罩結果: 連線網址之帳密(通用規則遮, 不需登錄)
const CRED = 'Pw9xQz7'
const MASKED = 'connect postgres://***@db.example.com:5432/app failed'
let mkCredErr = () => new Error(`connect postgres://alice:${CRED}@db.example.com:5432/app failed`)

//withBackend, 暫時以name之同名方法(會拋出mk()之值)取代Level.prototype上之後端方法, 結束還原
let withBackend = async(name, mk, fn) => {
    let own = Object.getOwnPropertyDescriptor(Level.prototype, name)
    Object.defineProperty(Level.prototype, name, {
        value: function() {
            throw mk()
        },
        configurable: true,
        writable: true,
    })
    try {
        return await fn()
    }
    finally {
        if (own !== undefined) {
            Object.defineProperty(Level.prototype, name, own)
        }
        else {
            delete Level.prototype[name]
        }
    }
}

//catchOf, 回傳promise之reject值(未reject回傳{ resolved })
let catchOf = async(pm) => {
    try {
        return { resolved: await pm }
    }
    catch (err) {
        return err
    }
}

//dumpAll, 含隱藏屬性、stack與cause之完整文字
let dumpAll = (v) => inspect(v, { depth: null, showHidden: true, maxStringLength: null, maxArrayLength: null, breakLength: Infinity })

//OPS, 後端會被呼叫而拋出之操作 × 其呼叫之後端方法(catch站點全集中屬後端者); mode為error事件之操作別
let OPS = [
    { op: 'select', mode: 'select', be: 'iterator', run: (wo) => wo.select({}) },
    { op: 'selectByPk', mode: 'selectByPk', be: 'get', run: (wo) => wo.selectByPk('a') },
    { op: 'insert', mode: 'insert', be: 'getMany', run: (wo) => wo.insert({ id: 'a' }) },
    { op: 'insertBulk', mode: 'insertBulk', be: 'getMany', run: (wo) => wo.insertBulk([{ id: 'a' }]) },
    { op: 'save', mode: 'save', be: 'getMany', run: (wo) => wo.save({ id: 'a' }) },
    { op: 'del', mode: 'del', be: 'getMany', run: (wo) => wo.del({ id: 'a' }) },
    { op: 'delAll(find)', mode: 'delAll', be: 'iterator', run: (wo) => wo.delAll({ id: 'a' }) },
    { op: 'delAll(全部)', mode: 'delAll', be: 'keys', run: (wo) => wo.delAll() },
]

//mkBadData, 使用端數據: 欄位bad為存取器, 讀取時拋出mk()之值(cloneDeep讀取時觸發, 屬外來值)
let mkBadData = (mk) => {
    let d = { id: 'u1' }
    Object.defineProperty(d, 'bad', {
        enumerable: true,
        get() {
            throw mk()
        },
    })
    return d
}

//USER_OPS, 使用端數據在寫入前處理(cloneDeep等)拋出之外來值 × 寫入類操作
let USER_OPS = [
    { op: 'insert', mode: 'insert', run: (wo, d) => wo.insert(d) },
    { op: 'insertBulk', mode: 'insertBulk', run: (wo, d) => wo.insertBulk([d]) },
    { op: 'save', mode: 'save', run: (wo, d) => wo.save(d) },
    { op: 'del', mode: 'del', run: (wo, d) => wo.del(d) },
]


describe('api-diagwire', function() {
    this.timeout(180000)

    before(function() {
        fs.rmSync(dirBase, { recursive: true, force: true })
    })

    after(async function() {
        for (let wo of opened) {
            await wo.close().catch(() => {})
        }
        fs.rmSync(dirBase, { recursive: true, force: true })
    })


    describe('外來值(後端)之reject與error事件: 含憑證者遮罩, 不含者原物件交出(D3)', function() {

        for (let row of OPS) {
            it(`${row.op}: 後端${row.be}拋出含憑證之錯誤: reject值與error事件之訊息皆已遮罩, 完整文字(含stack)不含憑證`, async function() {
                let { wo } = mkWo()
                let evs = []
                wo.on('error', (mode, data, msg) => evs.push([mode, msg]))
                let e = await withBackend(row.be, mkCredErr, () => catchOf(row.run(wo)))
                assert.ok(e instanceof Error, String(e && e.resolved))
                assert.strictEqual(e.message, MASKED)
                assert.ok(!dumpAll(e).includes(CRED))
                assert.deepStrictEqual(evs, [[row.mode, MASKED]])
                await wo.close()
            })

            it(`${row.op}: 後端${row.be}拋出不含憑證之錯誤: 原物件交出(身分不變, 自有屬性保留), error事件為其訊息`, async function() {
                let { wo } = mkWo()
                let evs = []
                wo.on('error', (mode, data, msg) => evs.push([mode, msg]))
                let thrown = Object.assign(new Error('disk is full'), { code: 'ENOSPC', extra: { n: 1 } })
                let e = await withBackend(row.be, () => thrown, () => catchOf(row.run(wo)))
                assert.strictEqual(e, thrown)
                assert.deepStrictEqual(evs, [[row.mode, 'disk is full']])
                await wo.close()
            })
        }

        it('close: 後端關閉失敗之reject為外來值: 含憑證者已遮, 不含者原物件; 還原後可正常關閉', async function() {
            let { wo } = mkWo()
            let e1 = await withBackend('close', mkCredErr, () => catchOf(wo.close()))
            assert.ok(e1 instanceof Error)
            assert.strictEqual(e1.message, MASKED)
            assert.ok(!dumpAll(e1).includes(CRED))
            let thrown = new Error('busy')
            let e2 = await withBackend('close', () => thrown, () => catchOf(wo.close()))
            assert.strictEqual(e2, thrown)
            assert.strictEqual(await wo.close(), undefined)
        })

        it('Level建構期拋錯(外來值)經diag.err: 儲存位址恆為非空字串故無法由外部觸發, 以原始碼盤點鎖定(見unit-diaglog之站點盤點)', function() {
            let code = fs.readFileSync(path.join(dirTest, '..', 'src', 'WOrmLevel.mjs'), 'utf8')
            assert.ok(/try \{\s*client = new Level\(storage, \{ valueEncoding: 'json' \}\)\s*\}\s*catch \(err\) \{\s*throw diag\.err\(err\)/.test(code))
        })

    })


    describe('外來值(使用端存取器於寫入前處理中拋出)之整批reject與error事件', function() {

        for (let row of USER_OPS) {
            it(`${row.op}: 存取器拋出含憑證之錯誤: reject值與error事件之訊息皆已遮罩, 且不寫入`, async function() {
                let { wo } = mkWo()
                let evs = []
                wo.on('error', (mode, data, msg) => evs.push([mode, msg]))
                let e = await catchOf(row.run(wo, mkBadData(mkCredErr)))
                assert.ok(e instanceof Error, String(e && e.resolved))
                assert.strictEqual(e.message, MASKED)
                assert.ok(!dumpAll(e).includes(CRED))
                assert.deepStrictEqual(evs, [[row.mode, MASKED]])
                assert.deepStrictEqual(await wo.select(), [])
                await wo.close()
            })

            it(`${row.op}: 存取器拋出不含憑證之錯誤: 原物件交出(身分不變)`, async function() {
                let { wo } = mkWo()
                let thrown = new RangeError('plain failure')
                let e = await catchOf(row.run(wo, mkBadData(() => thrown)))
                assert.strictEqual(e, thrown)
                await wo.close()
            })
        }

        it('存取器拋出非Error之外來值(字串含憑證、不含憑證、物件): 含憑證之字串已遮, 其餘原值', async function() {
            let { wo } = mkWo()
            let obj = { code: 'X', note: 'n' }
            let e1 = await catchOf(wo.insert(mkBadData(() => `connect postgres://alice:${CRED}@db.example.com:5432/app failed`)))
            assert.strictEqual(e1, MASKED)
            assert.strictEqual(await catchOf(wo.insert(mkBadData(() => 'plain text'))), 'plain text')
            assert.strictEqual(await catchOf(wo.insert(mkBadData(() => obj))), obj)
            await wo.close()
        })

    })


    describe('逐筆結果之err欄位(save、del): 外來值之訊息於建立時即遮, change事件、error事件與回傳值同源', function() {

        //mkCounted, 類別實例之id為原型上之可列舉存取器, 讀取第limit次(含)起拋出含憑證之錯誤:
        //cloneDeep只讀自有鍵, 故前幾次讀取發生在整批檢核階段(落入整批reject), 之後落入逐筆處理(落入逐筆err); 每個limit各試, 不依賴內部讀取次數
        let mkCounted = (limit) => {
            class D {}
            let reads = 0
            Object.defineProperty(D.prototype, 'id', {
                enumerable: true,
                get() {
                    reads++
                    if (reads >= limit) {
                        throw mkCredErr()
                    }
                    return 'k1'
                },
            })
            let o = new D()
            o.name = 'x'
            return o
        }

        for (let op of ['save', 'del']) {
            it(`${op}: 逐筆處理中拋出含憑證之外來錯誤: 該筆ok為0且err已遮; 整批reject者亦已遮; 至少一個情形落入逐筆路徑(非空轉)`, async function() {
                let { wo } = mkWo()
                let errEvs = []
                let chgRes = []
                wo.on('error', (mode, data, msg) => errEvs.push([mode, msg]))
                wo.on('change', (mode, data, res) => chgRes.push(JSON.stringify(res)))
                let nItem = 0
                let nBatch = 0
                for (let limit = 2; limit <= 16; limit++) {
                    let r = await catchOf(wo[op]([mkCounted(limit)]))
                    if (!(r instanceof Error) && r.resolved[0].ok === 0) {
                        nItem++
                        assert.strictEqual(r.resolved[0].err, MASKED, `limit ${limit}`)
                    }
                    else if (r instanceof Error) {
                        nBatch++
                        assert.strictEqual(r.message, MASKED, `limit ${limit}`)
                    }
                }
                assert.ok(nItem >= 1, '須有情形落入逐筆處理')
                assert.ok(nItem + nBatch >= 1)
                assert.ok(errEvs.length >= nItem + nBatch)
                for (let [, msg] of errEvs) {
                    assert.strictEqual(msg, MASKED)
                }
                assert.ok(!chgRes.join('').includes(CRED))
                await wo.close()
            })
        }

        it('逐筆err為套件自身之固定詞彙(invalid id等)者原樣', async function() {
            let { wo } = mkWo()
            let errEvs = []
            wo.on('error', (mode, data, msg) => errEvs.push([mode, msg]))
            let rs = await wo.save([{ id: 'bad\uD800' }, { id: 'ok1' }])
            assert.strictEqual(rs[0].err, 'invalid id: string contains lone surrogate at [data[0].id]')
            assert.strictEqual(rs[1].ok, 1)
            let rd = await wo.del([{ id: '' }, { id: 'ok1' }])
            assert.strictEqual(rd[0].err, 'invalid id: string is empty at [data[0].id]')
            assert.strictEqual(rd[1].ok, 1)
            assert.deepStrictEqual(errEvs, [
                ['save', 'invalid id: string contains lone surrogate at [data[0].id]'],
                ['del', 'invalid id: string is empty at [data[0].id]'],
            ])
            await wo.close()
        })

        it('逐筆err回顯使用端之鍵名(形似憑證)者原樣(新增列與既有列兩條路徑), 同文字若為外來值則會被遮(非空轉)', async function() {
            let { wo } = mkWo()
            let errEvs = []
            wo.on('error', (mode, data, msg) => errEvs.push([mode, msg]))
            const LIKE = 'token=abc123456789'
            const MSG = `invalid data: string contains lone surrogate at [data[0].${LIKE}]`

            //新增列與既有列(兩者皆由getWellFormedMsg之固定詞彙於逐筆處理前定案, 經mkOwnErr登記)
            let r1 = await wo.save([{ id: 's1', [LIKE]: 'x\uD800' }])
            assert.strictEqual(r1[0].ok, 0)
            assert.strictEqual(r1[0].err, MSG)
            await wo.save([{ id: 's3', name: 'a' }])
            let r2 = await wo.save([{ id: 's3', [LIKE]: 'y\uD800' }])
            assert.strictEqual(r2[0].ok, 0)
            assert.strictEqual(r2[0].err, MSG)
            assert.deepStrictEqual(errEvs, [['save', MSG], ['save', MSG]])

            //非空轉: 同一段文字若為外來值(使用端存取器拋出)即被遮
            let e = await catchOf(wo.save(mkBadData(() => new Error(MSG))))
            assert.ok(e instanceof Error)
            assert.notStrictEqual(e.message, MSG)
            assert.ok(!e.message.includes('abc123456789'))
            await wo.close()
        })

    })


    describe('套件自身以固定詞彙組成之reject原樣(D3: 固定字串挖空可反推秘密), 即使其回顯之使用端值形似憑證', function() {

        //LIKE, 形似憑證之使用端值(通用規則會遮之鍵值對)
        const LIKE = 'token=abc123456789'

        it('insertBulk之主鍵已存在: 訊息回顯使用端之id(契約), 原樣不遮; 同文字若為外來值則會被遮(非空轉)', async function() {
            let { wo } = mkWo()
            let evs = []
            wo.on('error', (mode, data, msg) => evs.push([mode, msg]))
            let MSG = `can not insertBulk by existed id[${LIKE}]`
            await wo.insertBulk([{ id: LIKE }])
            let e = await catchOf(wo.insertBulk([{ id: LIKE }]))
            assert.ok(e instanceof Error)
            assert.strictEqual(e.message, MSG)
            assert.deepStrictEqual(evs, [['insertBulk', MSG]])

            //非空轉: 同一段文字由外來值拋出(使用端存取器)即被遮
            let e2 = await catchOf(wo.insert(mkBadData(() => new Error(MSG))))
            assert.ok(e2 instanceof Error)
            assert.notStrictEqual(e2.message, MSG)
            assert.ok(!e2.message.includes('abc123456789'))
            await wo.close()
        })

        it('其餘固定詞彙之reject全集(含回顯使用端鍵名、欄名者): 訊息逐字不變', async function() {
            let { wo } = mkWo({ autoGenPk: false })
            let { wo: wo2 } = mkWo()
            let evs = []
            wo.on('error', (mode, data, msg) => evs.push([mode, msg]))
            wo2.on('error', (mode, data, msg) => evs.push([mode, msg]))
            let table = [
                [() => wo.insert({ name: 'no-id' }), 'can not insert by data[0] without valid id when autoGenPk is false'],
                [() => wo2.insert({ id: 'd1', [LIKE]: new Date(8.64e15) }), `invalid data: Date year is out of range 0000-9999 at [data[0][${JSON.stringify(LIKE)}]]`],
                [() => wo2.insert({ id: `bad\uD800` }), 'invalid id: string contains lone surrogate at [data[0].id]'],
                [() => wo2.select({ [LIKE]: 1 }), `invalid find: unsupported column name [${LIKE}] at [find.${LIKE}]`],
                [() => wo2.delAll({ $foo: 1 }), null],
            ]
            for (let [fn, exp] of table) {
                let e = await catchOf(fn())
                assert.ok(e instanceof Error, String(exp))
                if (exp !== null) {
                    assert.strictEqual(e.message, exp)
                }
            }
            assert.ok(evs.some(([, m]) => m === table[0][1]))
            assert.ok(evs.some(([, m]) => m === table[1][1]))

            //closed
            await wo2.close()
            let e = await catchOf(wo2.select())
            assert.strictEqual(e.message, 'can not select by closed client, instance can not be used after close()')
            await wo.close()
        })

    })


    describe('儲存路徑: 診斷輸出遮, 對外錯誤值不遮(Q3)', function() {

        it('後端錯誤之message與path含儲存位址: reject為原物件(身分不變、path完整)、error事件訊息原樣; 同值經訂閱函數轉拋時funLog細節之位址為***', async function() {
            let got = []
            let { wo, storage } = mkWo({ funLog: (...a) => got.push(a) })
            let thrown = Object.assign(new Error(`IO error: lock ${storage}/LOCK: boom`), { path: storage, code: 'LEVEL_IO_ERROR' })
            let seen = []
            wo.on('error', (mode, data, msg) => {
                seen.push(msg)
                throw new Error(`handler failed on ${mode}: ${msg}`)
            })
            let e = await withBackend('iterator', () => thrown, () => catchOf(wo.select()))
            assert.strictEqual(e, thrown)
            assert.strictEqual(e.path, storage)
            assert.deepStrictEqual(seen, [`IO error: lock ${storage}/LOCK: boom`])
            assert.strictEqual(got.length, 1)
            assert.strictEqual(got[0][0], 'error handler threw')
            assert.strictEqual(got[0][2].message, 'handler failed on select: IO error: lock ***/LOCK: boom')
            assert.ok(!dumpAll(got).includes(storage))
            await wo.close()
        })

        it('外來字串reject含儲存位址: 原樣(對外不遮)', async function() {
            let { wo, storage } = mkWo()
            let s = `failed at ${storage}`
            let e = await catchOf(wo.insert(mkBadData(() => s)))
            assert.strictEqual(e, s)
            await wo.close()
        })

    })


    describe('共用語料(wsemi/src/_diagCases.mjs)之wire案經本套件之真實呼叫點重跑', function() {

        //本套件唯一之秘密是儲存位址(無連線憑證): 語料之ctx.sec.password代換為本實例之儲存位址, 使語料之make/check可原樣使用;
        //秘密需求(noSecret)改以本套件實際宣告之儲存位址各形式(原樣、反斜線、絕對路徑)逐字比對, 不用語料之5字元窗(窗內片段如/test會與stack路徑重疊而誤報)
        let byId = (id) => cases.find((c) => c.id === id)
        let needlesOf = (url, ctx) => {
            let storage = `${url}/worm/users`
            let abs = path.resolve(url, 'worm', 'users')
            return [storage, storage.replace(/\//g, '\\'), abs, abs.replace(/\\/g, '/'), ...ctx.extra]
        }
        let assertNoLeak = (out, needles) => {
            let { ss, trunc } = collect(out)
            assert.ok(!trunc)
            for (let s of ss) {
                for (let x of needles) {
                    assert.ok(!s.includes(x), `leaked ${JSON.stringify(x)}`)
                }
            }
        }

        //DETAIL, 經change站之funLog細節(maskDiagCopy); BRIEF, 經funLog之safe(getDiagBriefErr); REJECT, 經reject(maskDiagErr)
        let DETAIL = ['T01', 'T07', 'K01', 'K09', 'V02', 'E01', 'E07', 'P01', 'S07']
        let BRIEF = ['C01']
        let REJECT = ['R01', 'T07']

        //NA, 不適用於本套件之wire案與理由
        let NA = {
            R02: '畸形網址片段之密碼: 本套件無連線網址秘密可登錄(reject清單只含憑證)',
            R04: '登錄之密碼字串reject: 本套件無憑證; 儲存路徑對外不遮(Q3), 見「儲存路徑」一節之字串reject案',
            R07: '固定詞彙reject不得經遮罩: 以本套件之固定詞彙reject原樣案驗證(「套件自身以固定詞彙組成之reject原樣」一節)',
            R11: '錯誤自帶path為儲存路徑: 語料之path為他處路徑, 以本套件實際儲存位址重寫於「儲存路徑」一節',
            R12: '單獨帳號: 本套件無帳號選項',
            O01: '語料以自建getDiag與固定標籤斷言: 本套件之出口標籤與輸出形式由api-diaglog驗證',
            O15: 'safe含白名單外之鍵: 本套件之safe只含mode, 無從注入白名單外之鍵; safeKeys宣告由unit-diaglog之站點盤點鎖定',
            A01: 'genDiagFunLog: 本套件不用伺服端轉接器',
            A07: 'genDiagFunLog: 本套件不用伺服端轉接器',
        }

        it('wire案歸類全集: 適用(DETAIL、BRIEF、REJECT)與不適用(NA, 附理由)之聯集等於語料中wire:true之全部案例(語料新增wire案時須歸類)', function() {
            let ids = cases.filter((c) => c.wire).map((c) => c.id).sort()
            let mine = [...new Set([...DETAIL, ...BRIEF, ...REJECT, ...Object.keys(NA)])].sort()
            assert.deepStrictEqual(mine, ids)
            assert.ok(ids.length >= 20)
        })

        for (let id of DETAIL) {
            it(`${id}(${byId(id).label}): 訂閱函數拋出語料之值, funLog細節無秘密(儲存位址)殘留且符語料期望`, async function() {
                let c = byId(id)
                let url = nextUrl()
                let ctx = mkCtx({})
                ctx.sec.password = `${url}/worm/users`
                let thrown = c.make(ctx)
                let got = []
                let wo = WOrm({ url, db: 'worm', cl: 'users', funLog: (...a) => got.push(a) })
                opened.push(wo)
                wo.on('change', () => {
                    throw thrown
                })
                await wo.insert({ id: 'w1' })
                await wo.close()
                assert.strictEqual(got.length, 1)
                assert.strictEqual(got[0].length, 3)
                let out = got[0][2]
                assertNoLeak(out, needlesOf(url, ctx))
                if (c.expect.userCode === 0) {
                    assert.strictEqual(ctx.hits, 0)
                }
                if (typeof c.expect.check === 'function') {
                    assert.strictEqual(c.expect.check(out, ctx), true)
                }
            })
        }

        for (let id of BRIEF) {
            it(`${id}(${byId(id).label}): 訂閱函數逐一拋出語料之錯誤, funLog之safe符語料期望(去除mode)`, async function() {
                let c = byId(id)
                let url = nextUrl()
                let ctx = mkCtx({})
                let list = c.make(ctx)
                let got = []
                let wo = WOrm({ url, db: 'worm', cl: 'users', funLog: (...a) => got.push(a) })
                opened.push(wo)
                let cur = null
                wo.on('change', () => {
                    throw cur
                })
                let k = 0
                for (let e of list) {
                    cur = e
                    await wo.insert({ id: `c${k++}` })
                }
                await wo.close()
                assert.strictEqual(got.length, list.length)
                let out = got.map((a) => {
                    let { mode, ...rest } = a[1]
                    assert.strictEqual(mode, 'insert')
                    return rest
                })
                assert.strictEqual(c.expect.check(out, ctx), true)
            })
        }

        for (let id of REJECT) {
            it(`${id}(${byId(id).label}): 使用端存取器拋出語料之值, reject值符語料期望`, async function() {
                let c = byId(id)
                let { wo, url } = mkWo()
                let ctx = mkCtx({})
                ctx.sec.password = `${url}/worm/users`
                let thrown = c.make(ctx)
                let got = await catchOf(wo.insert(mkBadData(() => thrown)))
                if (id === 'R01') {
                    assert.strictEqual(c.expect.check([thrown, got], ctx), true)
                }
                else {
                    //T07: 字串reject, 通用規則(Bearer、token=、"password":、authorization: Basic)遮罩, 期望值取自語料
                    assert.strictEqual(typeof got, 'string')
                    assert.strictEqual(c.expect.check(got, ctx), true)
                }
                await wo.close()
            })
        }

        it('T03(語料「網址帳密scheme://u:p@host(未登錄)」)的輸入作為外來字串reject: 期望值取自語料', async function() {
            let c = byId('T03')
            let { wo } = mkWo()
            let got = await catchOf(wo.insert(mkBadData(() => 'connect mysql://alice:s3cr3t@host:3306/db')))
            assert.strictEqual(c.expect.check(got), true)
            await wo.close()
        })

    })


    describe('診斷出口level(逐站驗證stdout/stderr, 真子行程)', function() {

        let runChild = (args) => new Promise((resolve, reject) => {
            let ch = spawn(process.execPath, [path.join(dirTest, 'tools', 'diagChild.mjs'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            let err = ''
            ch.stdout.on('data', (d) => {
                out += d
            })
            ch.stderr.on('data', (d) => {
                err += d
            })
            ch.on('error', reject)
            ch.on('close', (code) => resolve({ code, out, err }))
        })

        it('兩個站點(change handler threw、error handler threw)皆寫stdout(console.log), stderr為空', async function() {
            let r = await runChild([nextUrl()])
            assert.strictEqual(r.code, 0, r.err)
            assert.strictEqual(r.err, '')
            assert.deepStrictEqual(r.out.trim().split(/\r?\n/), [
                'change handler threw { mode: \'insert\', errType: \'Error\' }',
                'error handler threw { mode: \'insert\', errType: \'Error\' }',
            ])
        })

        it('logDetail: 兩個站點仍寫stdout, stderr為空, 細節為(標籤, 遮罩後拷貝)', async function() {
            let r = await runChild([nextUrl(), 'logDetail'])
            assert.strictEqual(r.code, 0, r.err)
            assert.strictEqual(r.err, '')
            let lines = r.out.split(/\r?\n/)
            assert.ok(lines[0].startsWith('change handler threw Error: listener boom'))
            assert.ok(r.out.includes('error handler threw Error: listener boom'))
        })

    })

})
