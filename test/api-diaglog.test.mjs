import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { inspect } from 'util'
import WOrm from '../src/WOrmLevel.mjs'
import { TYPES } from '../src/getDiag.mjs'
import { ID, NAME, LISTENER_MSG, scenario } from './tools/diagScenario.mjs'
import { CONFIGS } from './tools/diagConfigs.mjs'
import { capture, dump, tick } from './tools/diagCapture.mjs'


//診斷輸出(帳本R-DIAG-01)之整合測試: 真LevelDB、真訂閱函數拋錯, 擷取console與funLog實際收到之內容
//規則: ②預設只輸出標籤與不含個資之摘要; ③opt.logDetail還原細節(舊版console.log(拋出值))、opt.funLog(label, safe, detail)取代console、型別錯誤用預設;
//④回傳契約不變(resolve/reject內容、事件payload與順序, 對照修改前git HEAD程式產生之diagGolden.json); ⑤資料庫位置(opt.url、opt.db、opt.cl)視同連線字串, 不入預設輸出, 於細節(logDetail與funLog)遮罩, 建構函式訊息為固定詞彙;
//⑥診斷輸出自身不使操作拋錯、不執行使用端getter
//change與error兩個站點對稱測試: 凡拋出值型態、選項、快照、輸出自身拋錯之案, 兩個站點皆跑


let dirTest = path.dirname(fileURLToPath(import.meta.url))
let golden = JSON.parse(fs.readFileSync(path.join(dirTest, 'tools', 'diagGolden.json'), 'utf8'))

//dirBase, 本檔專用之臨時資料夾(test/_tmp/<案名>, 由after刪除)
let dirBase = './test/_tmp/diaglog'
let n = 0
let mkOpt = (extra = {}) => {

    //以屬性描述子複製extra(展開語法會於此處就執行其getter, 使「讀取選項拋錯」案無從送達WOrm)
    let opt = { url: `${dirBase}/d${n++}`, db: 'worm', cl: 'users' }
    Object.defineProperties(opt, Object.getOwnPropertyDescriptors(extra))
    return opt
}

//哨兵: 不得出現在預設輸出之字串
let SECRETS = [ID, NAME, LISTENER_MSG, 'u-secret', 'AliceSecret', 'listener ', '.mjs', process.cwd()]

let rmBase = () => {
    fs.rmSync(dirBase, { recursive: true, force: true })
}

//SITES, 兩個診斷站點: 以訂閱哪個事件使其拋錯、如何觸發該事件(操作別皆為insert)、預期標籤
//change站: insert成功即發出change; error站: 主鍵含孤立代理字元之insert整批reject並於reject前發出error
let SITES = {
    change: {
        label: 'change handler threw',
        trigger: (wo, k) => wo.insert({ id: `t${k}`, name: NAME }),
        expRes: { n: 1, nInserted: 1, ok: 1 },
    },
    error: {
        label: 'error handler threw',
        trigger: (wo) => wo.insert({ id: 'bad\uD800' }).then(() => 'resolved', (err) => err.message),
        expRes: 'invalid id: string contains lone surrogate at [data[0].id]',
    },
}


describe('api-diaglog', function() {
    this.timeout(180000)

    before(function() {
        rmBase()
    })

    after(function() {
        rmBase()
    })


    describe('預設(規則②): 只輸出標籤與不含個資之摘要', function() {

        it('change與error訂閱函數拋錯: 每次拋錯恰輸出一行console.log(標籤, { mode, errType }), 不含資料值、id、錯誤原文、堆疊、路徑', async function() {
            let r = await capture(() => scenario(WOrm, mkOpt(), true))
            let evs = r.result.evs
            assert.ok(evs.length >= 25)
            assert.strictEqual(r.calls.length, evs.length)
            assert.ok(r.calls.every((c) => c.fn === 'console.log'))
            r.calls.forEach((c, k) => {
                let [kind, mode] = evs[k]
                assert.deepStrictEqual(c.args, [kind === 'change' ? 'change handler threw' : 'error handler threw', { mode, errType: 'Error' }], `#${k}`)
            })
            let txt = dump(r.calls)
            for (let s of SECRETS) {
                assert.ok(!txt.includes(s), `輸出含${s}`)
            }

            //兩個站點都走過
            let labels = new Set(r.calls.map((c) => c.args[0]))
            assert.deepStrictEqual([...labels].sort(), ['change handler threw', 'error handler threw'])

            //操作別全集: change站5種(delAll、insert、insertBulk、save、del)、error站7種(含selectByPk與closed後之各操作)
            let pairs = new Set(r.calls.map((c) => `${c.args[0].split(' ')[0]}:${c.args[1].mode}`))
            assert.deepStrictEqual([...pairs].sort(), [
                'change:del', 'change:delAll', 'change:insert', 'change:insertBulk', 'change:save',
                'error:del', 'error:delAll', 'error:insert', 'error:insertBulk', 'error:save', 'error:select', 'error:selectByPk',
            ])
        })

        for (let site of Object.keys(SITES)) {
            it(`${site}站: 訂閱函數拋出之各型態: 摘要只列型別與機器代碼, 不執行getter`, async function() {
                let cnt = 0
                let hit = () => {
                    cnt++
                    return ID
                }
                let oddVal = {}
                for (let k of ['message', 'code', 'name', 'toString', 'constructor']) {
                    Object.defineProperty(oddVal, k, { get: hit, configurable: true })
                }
                let errWithGetter = new Error('x')
                Object.defineProperty(errWithGetter, 'code', { get: hit })
                class MyCodeError extends Error {}
                class SubCodeError extends MyCodeError {}
                let px = new Proxy(new Error(ID), {
                    get() {
                        cnt++
                        return ID
                    },
                })
                let table = [
                    [new Error(ID), { errType: 'Error' }],
                    [new RangeError(ID), { errType: 'RangeError' }],
                    [new SubCodeError(ID), { errType: 'SubCodeError' }],
                    [Object.assign(new Error(ID), { code: 'ENOENT' }), { errType: 'Error', errCode: 'ENOENT' }],
                    [Object.assign(new Error(ID), { code: 'LEVEL_DATABASE_NOT_OPEN' }), { errType: 'Error', errCode: 'LEVEL_DATABASE_NOT_OPEN' }],
                    [Object.assign(new Error(ID), { code: 4060 }), { errType: 'Error', errCode: 4060 }],
                    [Object.assign(new Error(ID), { code: ID }), { errType: 'Error' }],
                    [Object.assign(new Error(ID), { code: 'E123456789' }), { errType: 'Error' }],
                    [Object.assign(new Error(ID), { code: 123456789 }), { errType: 'Error' }],
                    [ID, { errType: 'string' }],
                    [42, { errType: 'number' }],
                    [undefined, { errType: 'undefined' }],
                    [null, { errType: 'null' }],
                    [{ message: ID, code: 'ERR_X' }, { errType: 'object', errCode: 'ERR_X' }],
                    [oddVal, { errType: 'object' }],
                    [errWithGetter, { errType: 'Error' }],
                    [px, { errType: TYPES.isProxy(px) ? 'Proxy' : 'Error' }],
                ]
                let cur = null
                let wo = WOrm(mkOpt())
                wo.on(site, () => {
                    throw cur
                })
                try {
                    let k = 0
                    for (let [v, exp] of table) {
                        cur = v
                        let r = await capture(() => SITES[site].trigger(wo, k++))
                        assert.deepStrictEqual(r.result, SITES[site].expRes)
                        assert.deepStrictEqual(r.calls, [{ fn: 'console.log', args: [SITES[site].label, { mode: 'insert', ...exp }] }], `#${k - 1}`)
                        assert.ok(!dump(r.calls).includes(ID))
                    }
                }
                finally {
                    await wo.close()
                }
                if (TYPES.isProxy(px)) {
                    assert.strictEqual(cnt, 0)
                }
            })
        }

        it('訂閱函數未拋錯: 全部操作(含失敗路徑與已關閉)零輸出, 含無訂閱函數者', async function() {
            let r = await capture(() => scenario(WOrm, mkOpt(), false))
            assert.ok(r.result.out.length >= 25)
            assert.deepStrictEqual(r.calls, [])
            let r2 = await capture(async() => {
                let wo = WOrm(mkOpt())
                let o = []
                o.push(await wo.insert({ id: ID, name: NAME }))
                o.push(await wo.select({ id: ID }))
                o.push(await wo.insert({ id: 'bad\uD800' }).catch((e) => e.message))
                o.push(await wo.close())
                o.push(await wo.select().catch((e) => e.message))
                return o
            })
            assert.strictEqual(r2.result.length, 5)
            assert.deepStrictEqual(r2.calls, [])
        })

    })


    describe('funLog(規則③): 取代console, 收完整細節(遮罩拷貝)', function() {

        it('收(label, safe, detail): safe同預設摘要, detail為訂閱函數拋出之錯誤的拷貝(含原文), 不寫console', async function() {
            let got = []
            let r = await capture(() => scenario(WOrm, mkOpt({ funLog: (...args) => got.push(args) }), true))
            let evs = r.result.evs
            assert.deepStrictEqual(r.calls, [])
            assert.strictEqual(got.length, evs.length)
            got.forEach((args, k) => {
                let [kind, mode] = evs[k]
                assert.strictEqual(args.length, 3)
                assert.strictEqual(args[0], kind === 'change' ? 'change handler threw' : 'error handler threw')
                assert.deepStrictEqual(args[1], { mode, errType: 'Error' })
                assert.ok(args[2] instanceof Error)
                assert.strictEqual(args[2].message, LISTENER_MSG)
                assert.ok(args[2].stack.startsWith(`Error: ${LISTENER_MSG}`))
            })
        })

        for (let site of Object.keys(SITES)) {
            it(`${site}站: detail為拋出值之拷貝(結構相同、非原參照), 字串與物件亦然; 原地修改拷貝不影響原物件`, async function() {
                let thrown = [Object.assign(new Error(ID), { code: 'ENOENT', ctx: { id: ID, list: [1, 2] } }), ID, { id: ID, nest: { a: [ID] } }, 42, null, undefined]
                let cur = null
                let got = []
                let wo = WOrm(mkOpt({ funLog: (...args) => got.push(args) }))
                wo.on(site, () => {
                    throw cur
                })
                try {
                    for (let k = 0; k < thrown.length; k++) {
                        cur = thrown[k]
                        await SITES[site].trigger(wo, k)
                    }
                }
                finally {
                    await wo.close()
                }
                assert.strictEqual(got.length, thrown.length)
                let e0 = got[0][2]
                assert.ok(e0 instanceof Error && e0 !== thrown[0])
                assert.strictEqual(e0.message, ID)
                assert.strictEqual(e0.code, 'ENOENT')
                assert.deepStrictEqual(e0.ctx, { id: ID, list: [1, 2] })
                assert.notStrictEqual(e0.ctx, thrown[0].ctx)
                assert.strictEqual(got[1][2], ID)
                assert.deepStrictEqual(got[2][2], { id: ID, nest: { a: [ID] } })
                assert.notStrictEqual(got[2][2], thrown[2])
                assert.strictEqual(got[3][2], 42)
                assert.strictEqual(got[4][2], null)
                assert.strictEqual(got[5][2], undefined)

                //原地修改拷貝: 原物件不變
                e0.ctx.id = '***'
                got[2][2].nest.a[0] = '***'
                assert.strictEqual(thrown[0].ctx.id, ID)
                assert.strictEqual(thrown[2].nest.a[0], ID)
            })
        }

        it('funLog原地遮罩帶有事件參數(data、res)之拋出值: 不污染後續事件參數與操作回傳值(資料與結果皆與無funLog時相同)', async function() {
            let run = async(funLog) => {
                let wo = WOrm(mkOpt(funLog === null ? {} : { funLog }))
                let evs = []
                let first = true
                wo.on('change', (mode, data, res) => {
                    evs.push([mode, JSON.parse(JSON.stringify(data)), JSON.parse(JSON.stringify(res))])
                    if (first) {
                        first = false
                        let e = new Error('listener boom')
                        e.ctx = { data, res }
                        throw e
                    }
                })
                let res = null
                try {
                    res = await wo.save([{ id: 'u1', name: 'Alice' }])
                }
                finally {
                    await wo.close()
                }
                return { res, evs }
            }
            let mask = (v) => {
                if (typeof v === 'string') {
                    return '***'
                }
                if (v !== null && typeof v === 'object') {
                    for (let k of Object.keys(v)) {
                        v[k] = mask(v[k])
                    }
                }
                return v
            }
            let base = (await capture(() => run(null))).result
            let masked = (await capture(() => run((label, safe, detail) => {
                mask(detail)
            }))).result
            assert.deepStrictEqual(masked, base)
            assert.ok(JSON.stringify(base).includes('Alice'))
            assert.ok(base.evs.length >= 2)
        })

        it('funLog優先於logDetail: 同給時只交給funLog, 不寫console', async function() {
            let got = []
            let r = await capture(() => scenario(WOrm, mkOpt({ logDetail: true, funLog: (...args) => got.push(args) }), true))
            assert.deepStrictEqual(r.calls, [])
            assert.strictEqual(got.length, r.result.evs.length)
        })

        it('funLog拋錯、回傳reject之promise(含自有then被覆寫之原生promise): 操作結果不變、不成為unhandledRejection', async function() {
            let un = []
            let onUn = (e) => un.push(e)
            process.on('unhandledRejection', onUn)
            try {
                for (let funLog of [
                    () => {
                        throw new Error('funLog boom')
                    },
                    () => Promise.reject(new Error('funLog rej')),
                    async() => {
                        throw new Error('funLog async')
                    },
                    () => {
                        let p = Promise.reject(new Error('funLog own then'))
                        Object.defineProperty(p, 'then', { value: null })
                        return p
                    },
                ]) {
                    let r = await capture(() => scenario(WOrm, mkOpt({ funLog }), true))
                    assert.deepStrictEqual(r.result, golden['base|bad'])
                    assert.deepStrictEqual(r.calls, [])
                }
                await tick()
                assert.deepStrictEqual(un, [])
            }
            finally {
                process.removeListener('unhandledRejection', onUn)
            }
        })

    })


    describe('logDetail(規則③): 還原舊版輸出', function() {

        it('logDetail:true: 每次拋錯輸出console.log(拋出值)(單一引數、無標籤), 內容為拋出錯誤之拷貝(含訊息與堆疊), 與修改前之輸出格式相同', async function() {
            let r = await capture(() => scenario(WOrm, mkOpt({ logDetail: true }), true))
            assert.strictEqual(r.calls.length, r.result.evs.length)
            for (let c of r.calls) {
                assert.strictEqual(c.fn, 'console.log')
                assert.strictEqual(c.args.length, 1)
                assert.ok(c.args[0] instanceof Error)
                assert.strictEqual(c.args[0].message, LISTENER_MSG)
                assert.ok(inspect(c.args[0]).startsWith(`Error: ${LISTENER_MSG}\n    at `))
            }
        })

        for (let site of Object.keys(SITES)) {
            it(`${site}站: logDetail:true: 拋出非Error值亦輸出(字串、物件為拷貝), 原物件不變`, async function() {
                let cur = null
                let wo = WOrm(mkOpt({ logDetail: true }))
                wo.on(site, () => {
                    throw cur
                })
                try {
                    let obj = { id: ID, nest: { a: 1 } }
                    let out = []
                    for (let v of [ID, obj, 42]) {
                        cur = v
                        let r = await capture(() => SITES[site].trigger(wo, out.length))
                        out.push(r.calls)
                    }
                    assert.deepStrictEqual(out, [
                        [{ fn: 'console.log', args: [ID] }],
                        [{ fn: 'console.log', args: [{ id: ID, nest: { a: 1 } }] }],
                        [{ fn: 'console.log', args: [42] }],
                    ])
                    assert.notStrictEqual(out[1][0].args[0], obj)
                }
                finally {
                    await wo.close()
                }
            })
        }

        it('logDetail:false明給者同預設', async function() {
            let r = await capture(() => scenario(WOrm, mkOpt({ logDetail: false }), true))
            assert.ok(r.calls.every((c) => c.args.length === 2 && c.args[1].errType === 'Error'))
            assert.ok(!dump(r.calls).includes(LISTENER_MSG))
        })

    })


    describe('選項型別錯誤(規則③): 忽略並用預設, 不throw(同useCache、autoGenPk)', function() {

        let runOnce = async(site, extra) => {
            let wo = null
            let r = await capture(async() => {
                wo = WOrm(mkOpt(extra))
                wo.on(site, () => {
                    throw new Error(LISTENER_MSG)
                })
                let res = await SITES[site].trigger(wo, 0)
                await wo.close()
                return res
            })
            return r
        }

        for (let site of Object.keys(SITES)) {
            let expCalls = [{ fn: 'console.log', args: [SITES[site].label, { mode: 'insert', errType: 'Error' }] }]

            it(`${site}站: logDetail為非布林(字串、數字、物件、陣列、null、undefined、0)者用預設`, async function() {
                for (let v of ['true', 1, {}, [], null, undefined, 0, 'yes', () => true]) {
                    let r = await runOnce(site, { logDetail: v })
                    assert.deepStrictEqual(r.result, SITES[site].expRes)
                    assert.deepStrictEqual(r.calls, expCalls, String(v))
                }
            })

            it(`${site}站: funLog為非函數(字串、數字、物件、布林、null)者用預設(仍寫console)`, async function() {
                for (let v of ['x', 1, {}, true, null, []]) {
                    let r = await runOnce(site, { funLog: v })
                    assert.deepStrictEqual(r.calls, expCalls, String(v))
                }
            })

            it(`${site}站: 讀取選項拋錯: 只丟該選項, 另一有效選項照常`, async function() {
                let got = []
                let r = await runOnce(site, {
                    get logDetail() {
                        throw new Error('getter boom')
                    },
                    funLog: (...args) => got.push(args)
                })
                assert.deepStrictEqual(r.calls, [])
                assert.strictEqual(got.length, 1)
                let r2 = await runOnce(site, {
                    logDetail: true,
                    get funLog() {
                        throw new Error('getter boom')
                    }
                })
                assert.strictEqual(r2.calls.length, 1)
                assert.ok(r2.calls[0].args[0] instanceof Error)
            })

            it(`${site}站: 選項於建構時取固定快照: 其後改動opt不影響輸出`, async function() {
                let opt = mkOpt()
                let wo = WOrm(opt)
                wo.on(site, () => {
                    throw new Error(LISTENER_MSG)
                })
                opt.logDetail = true
                opt.funLog = () => {}
                try {
                    let r = await capture(() => SITES[site].trigger(wo, 0))
                    assert.deepStrictEqual(r.calls, expCalls)
                }
                finally {
                    await wo.close()
                }
            })
        }

    })


    describe('回傳契約不變(規則④): 對照修改前git HEAD程式產生之固定預期值', function() {

        let optSets = {
            default: () => ({}),
            logDetail: () => ({ logDetail: true }),
            funLog: () => ({ funLog: () => {} }),
            both: () => ({ logDetail: true, funLog: () => {} }),
            funLogThrows: () => ({
                funLog: () => {
                    throw new Error('x')
                }
            }),
            typeErr: () => ({ logDetail: 'yes', funLog: 'x' }),
        }

        it('預期值非空轉: 含成功、失敗、逐筆失敗、事件與已關閉之各路徑(七個操作別皆含), 訊息維持舊版(含id回顯之reject訊息不變)', function() {
            assert.deepStrictEqual(Object.keys(golden).sort(), ['base|bad', 'base|ok', 'cache|bad', 'cache|ok', 'nopk|bad', 'nopk|ok'])
            let g = golden['base|ok']
            assert.strictEqual(g.out.length, 28)
            assert.strictEqual(g.out[5].err, `can not insertBulk by existed id[${ID}]`)
            assert.strictEqual(g.out[21].err, 'can not select by closed client, instance can not be used after close()')
            assert.strictEqual(g.out[22].err, 'can not selectByPk by closed client, instance can not be used after close()')
            assert.strictEqual(g.evs.length, 25)
            assert.deepStrictEqual(g.evs.map((e) => `${e[0]}:${e[1]}`).slice(0, 6), ['change:delAll', 'change:insert', 'change:insert', 'change:insert', 'change:insert', 'error:insertBulk'])
            assert.deepStrictEqual(new Set(g.evs.filter((e) => e[0] === 'error').map((e) => e[1])), new Set(['select', 'selectByPk', 'insert', 'insertBulk', 'save', 'del', 'delAll']))
            assert.deepStrictEqual(golden['base|ok'], golden['base|bad'])
        })

        for (let cfg of Object.keys(CONFIGS)) {
            for (let bad of [false, true]) {
                it(`${cfg} × 訂閱函數${bad ? '拋錯' : '不拋錯'} × 選項組(${Object.keys(optSets).join('、')}): resolve/reject內容、事件payload與順序皆同預期值`, async function() {
                    for (let name of Object.keys(optSets)) {
                        let r = await capture(() => scenario(WOrm, mkOpt({ ...CONFIGS[cfg], ...optSets[name]() }), bad))
                        assert.deepStrictEqual(r.result, golden[`${cfg}|${bad ? 'bad' : 'ok'}`], `${cfg}|${bad}|${name}`)
                    }
                })
            }
        }

    })


    describe('資料庫位置視同連線字串(規則⑤): 預設不含細節, 細節遮罩', function() {

        let SENT = ['URLSECRET', 'DBSECRET', 'CLSECRET']

        it('預設、logDetail、funLog三管道: 擷取到之全部內容皆不含opt.url、opt.db、opt.cl(訂閱函數拋錯情境)', async function() {
            let optBase = { url: `${dirBase}/URLSECRET_dir`, db: 'DBSECRET_name', cl: 'CLSECRET_name' }
            let outs = []
            for (let k of ['default', 'logDetail', 'funLog']) {
                let got = []
                let extra = k === 'logDetail' ? { logDetail: true } : (k === 'funLog' ? { funLog: (...args) => got.push(args) } : {})
                let r = await capture(() => scenario(WOrm, { ...optBase, ...extra }, true))
                assert.ok(fs.existsSync(`${dirBase}/URLSECRET_dir/DBSECRET_name/CLSECRET_name`), '資料夾確以哨兵名稱建立')
                let txt = dump([r.calls, got])
                for (let s of SENT) {
                    assert.ok(!txt.includes(s), `${k}輸出含${s}`)
                }
                outs.push([k, txt.length, r.calls.length, got.length])
                fs.rmSync(`${dirBase}/URLSECRET_dir`, { recursive: true, force: true })
            }

            //非空轉: 三管道皆有輸出內容(console或funLog)
            for (let [k, len, nc, ng] of outs) {
                assert.ok(len > 50 && nc + ng >= 25, k)
            }
        })

        it('後端I/O錯誤文字(含位址)經error訂閱函數轉拋: 預設、logDetail、funLog三管道皆不含位址名稱, 細節中該段為***', async function() {
            for (let ch of ['default', 'logDetail', 'funLog']) {
                let got = []
                let extra = ch === 'logDetail' ? { logDetail: true } : (ch === 'funLog' ? { funLog: (...args) => got.push(args) } : {})
                let url = `${dirBase}/URLSECRET_io_${ch}`
                let opt = { url, db: 'DBSECRET_name', cl: 'CLSECRET_name', ...extra }
                let dbFolder = `${url}/DBSECRET_name/CLSECRET_name`

                //寫入足量數據並關閉, 重開令LevelDB將log轉為.ldb, 再破壞.ldb使讀取失敗(後端I/O錯誤, 訊息含資料庫位置)
                let wo = WOrm(opt)
                let rows = []
                for (let i = 0; i < 50; i++) {
                    rows.push({ id: `k${i}`, val: 'x'.repeat(2000) })
                }
                await wo.insert(rows)
                await wo.close()
                let seen = []
                let wo2 = WOrm(opt)
                wo2.on('error', (mode, data, err) => {
                    seen.push(err)
                    throw new Error(`handler failed on ${mode}: ${err}`)
                })
                await wo2.selectByPk('k0')
                let ldbs = fs.readdirSync(dbFolder).filter((f) => f.endsWith('.ldb'))
                assert.ok(ldbs.length > 0, '須有.ldb檔可破壞')
                for (let f of ldbs) {
                    try {
                        fs.unlinkSync(path.join(dbFolder, f))
                    }
                    catch (e) {
                        fs.writeFileSync(path.join(dbFolder, f), 'corrupted-bytes')
                    }
                }
                let r = await capture(async() => {
                    for (let i = 0; i < 50; i++) {
                        await wo2.selectByPk(`k${i}`).catch(() => {})
                    }
                    await wo2.select().catch(() => {})
                })
                await wo2.close().catch(() => {})

                //前提(非空轉): 後端錯誤確實送達error事件且文字含位址(此為回傳契約內之訊息, 不變), 且有診斷輸出
                assert.ok(seen.length > 0 && seen.some((e) => e.includes('URLSECRET')), `${ch}: 後端錯誤文字應含位址`)
                assert.ok(r.calls.length + got.length >= seen.length, ch)

                //三管道皆不含位址名稱
                let txt = dump([r.calls, got])
                for (let s of SENT) {
                    assert.ok(!txt.includes(s), `${ch}輸出含${s}`)
                }
                if (ch !== 'default') {
                    assert.ok(txt.includes('handler failed on selectByPk: IO error: ***'), `${ch}: 位址段應為***`)
                }
                fs.rmSync(url, { recursive: true, force: true })
            }
        })

        it('拋出值之屬性值、屬性鍵、Symbol描述、巢狀陣列與cause含位址者, logDetail與funLog之細節遮罩(原物件不變)', async function() {
            let url = `${dirBase}/URLSECRET_obj`
            let storage = `${url}/DBSECRET_name/CLSECRET_name`
            let sym = Symbol(`d ${storage}`)
            let e = new Error(`msg ${storage}`, { cause: new Error(`cause ${storage}`) })
            e[`k ${storage}`] = { list: [storage, `x${storage}y`] }
            e[sym] = storage
            for (let ch of ['logDetail', 'funLog']) {
                let got = []
                let extra = ch === 'logDetail' ? { logDetail: true } : { funLog: (...args) => got.push(args) }
                let wo = WOrm({ url, db: 'DBSECRET_name', cl: 'CLSECRET_name', ...extra })
                wo.on('change', () => {
                    throw e
                })
                let r = await capture(() => wo.insert({ id: `o-${ch}` }))
                await wo.close()
                let txt = dump([r.calls, got])
                for (let s of SENT) {
                    assert.ok(!txt.includes(s), `${ch}輸出含${s}`)
                }
                assert.ok(txt.includes('***'), ch)
                assert.ok(txt.includes('msg ***') && txt.includes('cause ***'), ch)
            }
            assert.ok(e.message.includes('URLSECRET') && e.cause.message.includes('URLSECRET') && e[sym] === storage)
            fs.rmSync(url, { recursive: true, force: true })
        })

        it('建構函式訊息為固定詞彙, 不回顯位址名稱(含哨兵), 且不建立資料夾', function() {
            for (let name of ['url', 'db', 'cl']) {
                let opt = { url: `${dirBase}/URLSECRET2`, db: 'DBSECRET2', cl: 'CLSECRET2', [name]: `${name.toUpperCase()}SECRET2\uD800` }
                let err = null
                try {
                    WOrm(opt)
                }
                catch (e) {
                    err = e
                }
                assert.ok(err instanceof Error)
                assert.strictEqual(err.message, `invalid opt.${name}: string contains lone surrogate`)
                assert.ok(!/SECRET/.test(err.message))
            }
            assert.ok(!fs.existsSync(`${dirBase}/URLSECRET2`))
        })

    })


    describe('診斷輸出自身不使流程拋錯(規則⑥)', function() {

        for (let site of Object.keys(SITES)) {
            it(`${site}站: console.log拋錯(模擬格式化失敗): 操作照常完成, 改輸出(標籤, (unprintable))`, async function() {
                let wo = WOrm(mkOpt({ logDetail: true }))
                wo.on(site, () => {
                    throw new Error(LISTENER_MSG)
                })
                let outs = []
                let orgLog = console.log
                let nCall = 0
                console.log = (...args) => {
                    nCall++
                    if (nCall === 1) {
                        throw new Error('format boom')
                    }
                    outs.push(args)
                }
                let res = null
                try {
                    res = await SITES[site].trigger(wo, 0)
                }
                finally {
                    console.log = orgLog
                    await wo.close()
                }
                assert.deepStrictEqual(res, SITES[site].expRes)
                assert.deepStrictEqual(outs, [[SITES[site].label, '(unprintable)']])
            })

            it(`${site}站: 拋出值之細節含會令console.log拋錯的函數(inspect.custom): 拷貝後以標記代替, 操作照常完成且可輸出`, async function() {
                let odd = {
                    [inspect.custom]() {
                        throw new Error('inspect boom')
                    },
                    a: 1,
                }
                let wo = WOrm(mkOpt({ logDetail: true }))
                wo.on(site, () => {
                    throw odd
                })
                let outs = []
                let orgLog = console.log
                console.log = (...args) => {
                    outs.push(inspect(args))
                }
                let res = null
                try {
                    res = await SITES[site].trigger(wo, 0)
                }
                finally {
                    console.log = orgLog
                    await wo.close()
                }
                assert.deepStrictEqual(res, SITES[site].expRes)
                assert.strictEqual(outs.length, 1)
                assert.ok(outs[0].includes('a: 1'))
            })
        }

        it('error訂閱函數拋出null原型物件: error事件payload與reject不變, 僅輸出摘要', async function() {
            let wo = WOrm(mkOpt({ autoGenPk: false }))
            let seen = []
            wo.on('error', (mode, data, err) => {
                seen.push([mode, err])
                throw Object.create(null)
            })
            let r = await capture(async() => {
                let msg = await wo.insert({ name: 'no-id' }).catch((e) => e.message)
                await wo.close()
                return msg
            })
            assert.strictEqual(r.result, 'can not insert by data[0] without valid id when autoGenPk is false')
            assert.deepStrictEqual(seen, [['insert', 'can not insert by data[0] without valid id when autoGenPk is false']])
            assert.deepStrictEqual(r.calls, [{ fn: 'console.log', args: ['error handler threw', { mode: 'insert', errType: 'object' }] }])
        })

    })

})
