import assert from 'assert'
import fs from 'fs'
import path from 'path'
import w from 'wsemi'
import { Level } from 'level'
import cvStrCases from 'wsemi/src/_cvOrmStrCases.mjs'
import chkOrmData from 'wsemi/src/chkOrmData.mjs'
import WOrm from '../src/WOrmLevel.mjs'


//字串良構(帳本R-ORMSTR-01; 規則: C:\opensrcOper\dspec\w-orm系列條件語法支援盤點.md〈一之三〉9.)
//共用檢核為wsemi之chkOrmStr、chkOrmData, 契約案例表為wsemi之_cvOrmStrCases(各w-orm-*逐案對公開API執行, 每案全新資料表),
//本檔驗證各入口(insert、insertBulk、save、del、selectByPk與建構)確實呼叫共用檢核並只使用複製後之複本;
//level之鍵經UTF-8編碼, 孤立代理字元之主鍵被改寫為U+FFFD而與他筆相撞(誤覆蓋、誤刪、誤命中), 值為JSON故能保真但系列一律拒收(D1)
//level能力: doc=可帶任意欄位名與巢狀結構; 無GridFS(group='gfs'與need含'gfs'者略過)
describe('wellformed', function() {
    let root = './test/_tmp/wellformed'
    let { cases, forms, reasons } = cvStrCases

    //mk, 案例表之文件工廠(夾具: 字串型主鍵欄id與字串欄name)
    let mk = (id, extra) => ({ id, name: 'n', ...extra })

    //msgOf, 取reject值之訊息
    let msgOf = (err) => (err instanceof Error ? err.message : String(err))

    //assertPartial, 取回文件須含期望之各鍵且深度相等(其餘鍵不論)
    let assertPartial = (actual, part) => {
        assert.strict.ok(actual !== null && actual !== undefined, 'row should exist')
        for (let [k, v] of Object.entries(part)) {
            assert.strict.deepStrictEqual(actual[k], v, `row field [${k}]`)
        }
    }

    let seq = 0
    let nSkipGfs = 0
    let nRan = 0
    let nInvariant = 0

    //freshBackend, 每案全新資料表; 以wo.close之包裝於關閉後刪除該資料夾(數千案不刪將累積大量檔案)
    let freshBackend = (extraOpt = {}) => {
        seq++
        let cl = `c${seq}`
        let wo = WOrm({ url: root, db: 'worm', cl, ...extraOpt })
        let close = wo.close
        wo.close = async() => {
            await close()
            w.fsDeleteFolder(path.join(root, 'worm', cl))
        }
        return wo
    }

    before(function() {
        w.fsDeleteFolder(root)
    })

    after(function() {
        w.fsDeleteFolder(root)
        assert.strict.ok(!fs.existsSync(root), 'test folder should be removed')
    })

    //runCase, 依案例表檔頭[後端套用方式]逐案執行; caseOpt為建構之額外設定
    let runCase = async function(ctx, c, caseOpt = {}) {

        //caps, level: doc可、gfs無
        if (c.need.includes('gfs')) {
            nSkipGfs++
            return ctx.skip()
        }
        nRan++
        let baseOpt = { url: root, db: 'worm', cl: 'cbase', ...caseOpt }
        let e = c.expect
        let args = c.args(mk, baseOpt)

        //建構之案例: 同步throw, 訊息全等
        if (e.kind === 'throw') {
            assert.throws(() => WOrm(...args), (err) => msgOf(err) === e.msg)
            return
        }

        let wo = freshBackend(caseOpt)
        try {
            await wo.insertBulk(c.pre(mk))

            let before = {}
            for (let id of (e.unchanged || [])) {
                before[id] = await wo.selectByPk(id)
            }

            //evs, 記錄呼叫期間之error事件
            let evs = []
            wo.on('error', (mode, data, err) => evs.push({ mode, err }))

            let r = null
            let rej = null
            try {
                let p = wo[c.api](...args)
                if (c.afterCall) {
                    c.afterCall(args)
                }
                r = await p
            }
            catch (err) {
                rej = err
            }

            if (c.afterCall) {
                //呼叫後立即改動原輸入(group='toctou' mutate-after-call): level於操作開始(序列化佇列輪到時)才cloneDeep輸入(帳本R-WRITE-ERR-01規則1: 前置處理全在Core之try內,
                //外殼不讀輸入值; R-DATE-01之TOCTOU不變式同此), 故呼叫後立即改動之輸入可能被取用, 與案例表預期之[呼叫當時之值]不同(lmdb於呼叫內同步複製故可);
                //本批要求之不變式為[檢查之值即寫入之值]: 無論取到改動前或改動後之值, 寫入者必經檢核, 資料庫內不得出現孤立代理字元, 失敗者以invalid data回報
                nInvariant++
                if (rej) {
                    assert.strict.ok(/^invalid data: string contains lone surrogate at \[data\[1\]\.name\]$/.test(msgOf(rej)), `unexpected rejection: ${msgOf(rej)}`)
                }
                else if (Array.isArray(r)) {
                    for (let x of r) {
                        if (x.ok === 0) {
                            assert.strict.ok(/^invalid data: string contains lone surrogate at \[data\[1\]\.name\]$/.test(String(x.err)), `unexpected item error: ${x.err}`)
                        }
                    }
                }
                for (let row of await wo.select()) {
                    assert.strict.equal(chkOrmData(row), null, 'database should not contain lone surrogate')
                }
                for (let id of (e.unchanged || [])) {
                    assert.strict.deepStrictEqual(await wo.selectByPk(id), before[id], `unchanged [${id.length}]`)
                }
                return
            }

            if (e.kind === 'free') {
                //值與鍵名之NUL不屬共用檢核: 可接受, 亦可因自身限制拒收, 但拒收訊息不得為共用檢核之詞彙
                let re = new RegExp(e.notMsg)
                if (rej) {
                    assert.strict.ok(!re.test(msgOf(rej)), `free case should not be rejected by shared check: ${msgOf(rej)}`)
                }
                else if (Array.isArray(r)) {
                    for (let x of r) {
                        if (x.ok === 0) {
                            assert.strict.ok(!re.test(String(x.err)), `free case item should not be rejected by shared check: ${x.err}`)
                        }
                    }
                }
            }
            else if (e.kind === 'rejectAll') {
                assert.strict.ok(rej, 'should reject')
                assert.strict.equal(msgOf(rej), e.msg)
            }
            else {
                assert.strict.ok(!rej, `must not reject: ${rej ? msgOf(rej) : ''}`)
                if (e.kind === 'null') {
                    assert.strict.equal(r, null)
                }
                if (e.kind === 'itemErr') {
                    assert.strict.ok(Array.isArray(r), 'result should be array')
                    r.forEach((x, i) => {
                        if (e.bad.includes(i)) {
                            assert.strict.deepStrictEqual([x.ok, x.err], [0, e.msgs ? e.msgs[e.bad.indexOf(i)] : e.msg], `item ${i}`)
                        }
                        else {
                            assert.strict.equal(x.ok, 1, `item ${i} should be ok`)
                        }
                    })
                }
            }
            //error事件(統一規格T10): 整批reject者於reject之前恰一次且訊息全等reject; 逐筆失敗者依序各一次且訊息全等該筆err; 回null與成功者無
            if (e.kind === 'rejectAll') {
                assert.strict.deepStrictEqual(evs, [{ mode: c.api, err: e.msg }], 'error event')
            }
            else if (e.kind === 'itemErr') {
                assert.strict.deepStrictEqual(evs, e.bad.map((v, j) => ({ mode: c.api, err: e.msgs ? e.msgs[j] : e.msg })), 'error events')
            }
            else if (e.kind === 'null' || e.kind === 'ok') {
                assert.strict.deepStrictEqual(evs, [], 'no error event')
            }
            if (e.kind === 'ok' && /^insert/.test(c.api)) {
                assert.strict.equal(r.ok, 1)
            }
            if (e.ids) {
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.id).sort(), e.ids)
            }
            for (let id of (e.unchanged || [])) {
                assert.strict.deepStrictEqual(await wo.selectByPk(id), before[id], `unchanged [${id.length}]`)
            }
            if (e.kind === 'ok' && e.result) {
                assertPartial(r, e.result)
            }
            for (let [id, part] of Object.entries(e.rows || {})) {
                assertPartial(await wo.selectByPk(id), part)
            }
        }
        finally {
            await wo.close()
        }
    }

    //案例分組: 單元層(group='str'與'data')由wsemi自身測試執行, 本套件只跑API層
    let apiCases = cases.filter((v) => v.group !== 'str' && v.group !== 'data')
    let againCases = apiCases.filter((v) => ['id', 'single', 'val', 'order'].includes(v.group))

    describe('cases(autoGenPk預設)', function() {
        for (let c of apiCases) {
            it(c.id, async function() {
                await runCase(this, c)
            })
        }
    })

    describe('cases(autoGenPk:false; 檢核不隨autoGenPk改變, 規則9.6)', function() {
        for (let c of againCases) {
            it(c.id, async function() {
                await runCase(this, c, { autoGenPk: false })
            })
        }
    })

    describe('案例完整度與略過計數', function() {
        it('API層案例皆被執行, 僅need含gfs者(GridFS, 本後端無)略過', function() {
            let all = [...apiCases, ...againCases]
            let nGfs = all.filter((v) => v.need.includes('gfs')).length
            assert.strict.ok(nGfs > 0 && nGfs < all.length)
            assert.strict.equal(nSkipGfs, nGfs)
            assert.strict.equal(nRan, all.length - nGfs)
            assert.strict.ok(nRan > 1000, `ran ${nRan}`)

            //mutate-after-call 3案(insert、insertBulk、save)改以不變式斷言(見runCase), 計數固定
            assert.strict.equal(nInvariant, all.filter((v) => v.afterCall).length)
            assert.strict.equal(nInvariant, 3)
        })
    })

    describe('level特有: UTF-8鍵之碰撞(孤立主鍵被改寫為U+FFFD而與他筆相撞)', function() {
        let H = 'a\uD800'
        let L = 'a\uDC00'
        let F = 'a\uFFFD'

        it('預存U+FFFD主鍵之列, 孤立主鍵之insert、insertBulk、save、del、selectByPk皆不命中該列', async function() {
            let wo = freshBackend()
            try {
                await wo.insert({ id: F, name: 'fffd' })
                let before = await wo.selectByPk(F)
                for (let id of [H, L]) {
                    await assert.rejects(() => wo.insert({ id, name: 'x' }), (err) => /^invalid id: string contains lone surrogate at \[data\[0\]\.id\]$/.test(msgOf(err)))
                    await assert.rejects(() => wo.insertBulk([{ id, name: 'x' }]), (err) => /^invalid id: string contains lone surrogate at \[data\[0\]\.id\]$/.test(msgOf(err)))
                    let rs = await wo.save({ id, name: 'x' })
                    assert.strict.deepStrictEqual(rs.map((v) => v.ok), [0])
                    let rd = await wo.del({ id })
                    assert.strict.deepStrictEqual(rd.map((v) => v.ok), [0])
                    assert.strict.equal(await wo.selectByPk(id), null)
                }
                assert.strict.deepStrictEqual(await wo.selectByPk(F), before)
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.id), [F])
            }
            finally {
                await wo.close()
            }
        })

        it('孤立或含NUL之主鍵不被送進資料庫查詢(save與del之getMany之鍵皆為良構主鍵), 同批之良構筆照常處理', async function() {
            let wo = freshBackend()
            let orig = Level.prototype.getMany
            let calls = []
            try {
                await wo.insertBulk([{ id: F, name: 'fffd' }, { id: 'k1', name: 'k1' }, { id: 'k2', name: 'k2' }])
                Level.prototype.getMany = function(keys, ...rest) {
                    calls.push(keys.slice())
                    return orig.call(this, keys, ...rest)
                }
                let rs = await wo.save([{ id: H, name: 'x' }, { id: 'k1', name: 'y' }, { id: 'n\u0000x', name: 'z' }])
                assert.strict.deepStrictEqual(rs.map((v) => v.ok), [0, 1, 0])
                let rd = await wo.del([{ id: L }, { id: 'k2' }, { id: 'n\u0000x' }, { id: '' }, { id: 5 }])
                assert.strict.deepStrictEqual(rd.map((v) => v.ok), [0, 1, 0, 0, 0])
                Level.prototype.getMany = orig
                let keys = calls.flat()
                assert.strict.ok(keys.length >= 2, `getMany should have been called with the valid ids: ${JSON.stringify(keys)}`)
                for (let k of keys) {
                    assert.strict.equal(typeof k, 'string')
                    assert.strict.ok(k.isWellFormed() && !k.includes('\u0000') && k !== '', `invalid key sent to getMany: ${JSON.stringify(k)}`)
                }
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.id).sort(), [F, 'k1'].sort())
            }
            finally {
                Level.prototype.getMany = orig
                await wo.close()
            }
        })

        it('孤立主鍵不被送進查詢: 同批之良構筆照常處理(del含壞筆與好筆)', async function() {
            let wo = freshBackend()
            try {
                await wo.insertBulk([{ id: F, name: 'fffd' }, { id: 'k1', name: 'k1' }])
                let rd = await wo.del([{ id: H }, { id: 'k1' }, { id: L }])
                assert.strict.deepStrictEqual(rd.map((v) => v.ok), [0, 1, 0])
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.id), [F])
            }
            finally {
                await wo.close()
            }
        })
    })

    describe('level特有: 舊資料(孤立主鍵於修正前寫入, D8不遷移)', function() {
        //以裸Level(開啟參數同src/WOrmLevel.mjs)造修正前寫入之舊列: 鍵為孤立代理經UTF-8化後之U+FFFD, 值(JSON)內之id欄保真為孤立代理
        let legacyId = 'a\uD800'
        let legacyKey = 'a\uFFFD'

        //seedLegacy, 先以裸Level寫入舊列後關閉
        let seedLegacy = async(cl) => {
            let p = path.resolve(root, 'worm', cl)
            fs.mkdirSync(path.dirname(p), { recursive: true })
            let db = new Level(p, { valueEncoding: 'json' })
            await db.open()
            await db.put(legacyKey, { id: legacyId, name: 'legacy' })
            await db.put('plain', { id: 'plain', name: 'plain' })
            await db.put('n\u0000x', { id: 'n\u0000x', name: 'nul' })
            await db.close()
        }

        //closeLegacy, 關閉後刪除該資料夾
        let closeLegacy = async(wo, cl) => {
            await wo.close()
            w.fsDeleteFolder(path.join(root, 'worm', cl))
        }

        it('select仍讀得到舊列(id為孤立代理): README之檢出法可檢出', async function() {
            seq++
            let cl = `legacy${seq}`
            await seedLegacy(cl)
            let wo = WOrm({ url: root, db: 'worm', cl })
            try {
                let rs = await wo.select()
                let bad = rs.filter((r) => typeof r.id === 'string' && !r.id.isWellFormed())
                assert.strict.deepStrictEqual(bad.map((v) => v.name), ['legacy'])
            }
            finally {
                await closeLegacy(wo, cl)
            }
        })

        it('以孤立id定址之selectByPk、del被拒(null、逐筆ok:0), 不誤中以U+FFFD為鍵之舊列', async function() {
            seq++
            let cl = `legacy${seq}`
            await seedLegacy(cl)
            let wo = WOrm({ url: root, db: 'worm', cl })
            try {
                assert.strict.equal(await wo.selectByPk(legacyId), null)
                let r = await wo.del([{ id: legacyId }, { id: 'plain' }])
                assert.strict.deepStrictEqual(r.map((v) => v.ok), [0, 1])
                assert.strict.equal(r[0].err, 'invalid id: string contains lone surrogate at [data[0].id]')
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.name).sort(), ['legacy', 'nul'])

                //含NUL之舊主鍵同樣被拒(D2): selectByPk回null、del逐筆ok:0, 舊列留存
                assert.strict.equal(await wo.selectByPk('n\u0000x'), null)
                let rn = await wo.del({ id: 'n\u0000x' })
                assert.strict.equal(rn[0].err, 'invalid id: string contains NUL at [data[0].id]')
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.name).sort(), ['legacy', 'nul'])
            }
            finally {
                await closeLegacy(wo, cl)
            }
        })

        it('舊列之值含孤立代理(JSON保真留存): 對該列save未含該欄之更新照常成功(不連坐檢核既有內容), 舊值原樣保留; save若寫入孤立代理則仍拒收', async function() {
            seq++
            let cl = `legacyval${seq}`
            let p = path.resolve(root, 'worm', cl)
            fs.mkdirSync(path.dirname(p), { recursive: true })
            let raw = new Level(p, { valueEncoding: 'json' })
            await raw.open()
            await raw.put('p2', { id: 'p2', note: 'x\uD800', n: 1 })
            await raw.close()
            let wo = WOrm({ url: root, db: 'worm', cl })
            try {
                let r = await wo.save([{ id: 'p2', k: 1 }])
                assert.strict.deepStrictEqual(r.map((v) => v.ok), [1])
                assert.strict.deepStrictEqual(await wo.selectByPk('p2'), { id: 'p2', note: 'x\uD800', n: 1, k: 1 })
                let r2 = await wo.save([{ id: 'p2', note2: 'y\uDC00' }])
                assert.strict.deepStrictEqual(r2.map((v) => v.ok), [0])
                assert.strict.equal(r2[0].err, 'invalid data: string contains lone surrogate at [data[0].note2]')
            }
            finally {
                await closeLegacy(wo, cl)
            }
        })

        it('清除路徑: 以U+FFFD同形字串為id之del, 或依他欄之delAll, 可刪除舊列', async function() {
            for (let way of ['del', 'delAll']) {
                seq++
                let cl = `legacy${seq}`
                await seedLegacy(cl)
                let wo = WOrm({ url: root, db: 'worm', cl })
                try {
                    if (way === 'del') {
                        let r = await wo.del({ id: legacyKey })
                        assert.strict.deepStrictEqual(r, [{ n: 1, nDeleted: 1, ok: 1 }])
                    }
                    else {
                        let r = await wo.delAll({ name: 'legacy' })
                        assert.strict.deepStrictEqual(r, { n: 1, nDeleted: 1, ok: 1 })
                    }
                    assert.strict.deepStrictEqual((await wo.select()).map((v) => v.name).sort(), ['nul', 'plain'])
                }
                finally {
                    await closeLegacy(wo, cl)
                }
            }
        })
    })

    describe('level特有: save合併路徑之繼承存取器(檢查之值即寫入之值)', function() {
        //類別實例(原型非Object.prototype)上之可列舉存取器: cloneDeep保留原型故仍在複本上, lodash merge(keysIn)於合併時讀取之;
        //存取器每次讀取可回不同值, 故合併後之最終物件(實際寫入者)須再檢核一次
        let mkInh = (id, vals) => {
            let n = 0
            let proto = {
                get flip() {
                    let v = vals[Math.min(n, vals.length - 1)]
                    n++
                    return v
                }
            }
            let d = Object.create(proto)
            d.id = id
            d.name = 'n'
            return d
        }

        it('繼承存取器首次讀回良構值、其後讀回孤立代理: 該筆ok:0附err, 原記錄不變', async function() {
            let wo = freshBackend()
            try {
                await wo.insert({ id: 'g1', name: 'pre' })
                let r = await wo.save([mkInh('g1', ['ok', 'bad\uD800'])])
                assert.strict.deepStrictEqual(r.map((v) => v.ok), [0])
                assert.strict.equal(r[0].err, 'invalid data: string contains lone surrogate at [data[0].flip]')
                assert.strict.deepStrictEqual(await wo.selectByPk('g1'), { id: 'g1', name: 'pre' })
            }
            finally {
                await wo.close()
            }
        })

        it('繼承存取器自第k次讀取起回孤立代理(k=1..6): 寫入者不得為孤立代理(該筆拒收且原記錄不變, 或寫入檢核所讀之良構值)', async function() {
            let nRej = 0
            let nOk = 0
            for (let kBad = 1; kBad <= 6; kBad++) {
                let wo = freshBackend()
                try {
                    await wo.insert({ id: 'g1', name: 'pre' })
                    let n = 0
                    let proto = {
                        get flip() {
                            n++
                            return n >= kBad ? 'bad\uD800' : 'ok'
                        }
                    }
                    let d = Object.create(proto)
                    d.id = 'g1'
                    d.name = 'n'
                    let r = await wo.save([d])
                    let row = await wo.selectByPk('g1')
                    if (r[0].ok === 0) {
                        nRej++
                        assert.strict.equal(r[0].err, 'invalid data: string contains lone surrogate at [data[0].flip]', `k=${kBad}`)
                        assert.strict.deepStrictEqual(row, { id: 'g1', name: 'pre' }, `k=${kBad}`)
                    }
                    else {
                        nOk++
                        assert.strict.equal(row.flip, 'ok', `k=${kBad}`)
                    }
                }
                finally {
                    await wo.close()
                }
            }
            assert.strict.ok(nRej >= 1 && nOk >= 1, `both outcomes should occur: rejected ${nRej}, written ${nOk}`)
        })

        it('繼承存取器恆回良構值: 照常合併存入(既有行為不變)', async function() {
            let wo = freshBackend()
            try {
                await wo.insert({ id: 'g1', name: 'pre' })
                let r = await wo.save([mkInh('g1', ['ok'])])
                assert.strict.deepStrictEqual(r.map((v) => v.ok), [1])
                assert.strict.deepStrictEqual(await wo.selectByPk('g1'), { id: 'g1', name: 'n', flip: 'ok' })
            }
            finally {
                await wo.close()
            }
        })

        it('繼承存取器於檢核時即回孤立代理: 該筆ok:0附err(檢核先於讀取與寫入)', async function() {
            let wo = freshBackend()
            try {
                await wo.insert({ id: 'g1', name: 'pre' })
                let r = await wo.save([mkInh('g1', ['bad\uD800'])])
                assert.strict.deepStrictEqual(r.map((v) => v.ok), [0])
                assert.strict.equal(r[0].err, 'invalid data: string contains lone surrogate at [data[0].flip]')
                assert.strict.deepStrictEqual(await wo.selectByPk('g1'), { id: 'g1', name: 'pre' })
            }
            finally {
                await wo.close()
            }
        })
    })

    describe('事件、時序與呼叫形式', function() {
        let H = 'a\uD800'

        it('insert/insertBulk整批reject: error事件於reject前恰一次, 訊息同reject, 不發change', async function() {
            for (let fn of ['insert', 'insertBulk']) {
                let wo = freshBackend()
                try {
                    let evs = []
                    wo.on('error', (mode, data, err) => evs.push({ t: 'error', mode, err }))
                    wo.on('change', (mode) => evs.push({ t: 'change', mode }))
                    let rej = null
                    try {
                        await wo[fn]([mk('g0'), mk(H)])
                    }
                    catch (err) {
                        rej = err
                    }
                    assert.strict.ok(rej)
                    assert.strict.deepStrictEqual(evs, [{ t: 'error', mode: fn, err: 'invalid id: string contains lone surrogate at [data[1].id]' }], fn)
                    assert.strict.equal(msgOf(rej), 'invalid id: string contains lone surrogate at [data[1].id]')
                    assert.strict.deepStrictEqual(await wo.select(), [])
                }
                finally {
                    await wo.close()
                }
            }
        })

        it('insert之returnList:true遇壞列: 仍整批reject(不回逐筆清單), error事件恰一次', async function() {
            let wo = freshBackend()
            try {
                let evs = []
                wo.on('error', (mode, data, err) => evs.push({ mode, err }))
                await assert.rejects(() => wo.insert([mk('g0'), mk(H)], { returnList: true }), (err) => msgOf(err) === 'invalid id: string contains lone surrogate at [data[1].id]')
                assert.strict.deepStrictEqual(evs, [{ mode: 'insert', err: 'invalid id: string contains lone surrogate at [data[1].id]' }])
                assert.strict.deepStrictEqual(await wo.select(), [])
            }
            finally {
                await wo.close()
            }
        })

        it('save/del逐筆: 各壞筆error事件一次(訊息含該筆索引), 整批定案後發出, 其餘筆照常', async function() {
            let wo = freshBackend()
            try {
                await wo.insertBulk([mk('k1')])
                let evs = []
                wo.on('error', (mode, data, err) => evs.push({ t: 'error', mode, err }))
                wo.on('change', (mode) => evs.push({ t: 'change', mode }))
                let rs = await wo.save([mk(H, { name: 'x' }), mk('k1', { name: 'y' }), mk('b\uDC00', { name: 'z' })])
                assert.strict.deepStrictEqual(rs.map((v) => v.ok), [0, 1, 0])
                assert.strict.deepStrictEqual(evs.filter((v) => v.t === 'error').map((v) => v.err), [
                    'invalid id: string contains lone surrogate at [data[0].id]',
                    'invalid id: string contains lone surrogate at [data[2].id]',
                ])
                assert.strict.deepStrictEqual(evs.map((v) => v.t), ['error', 'error', 'change'])
                evs.length = 0
                let rd = await wo.del([{ id: H }, { id: 'k1' }, { id: 'b\uDC00' }])
                assert.strict.deepStrictEqual(rd.map((v) => v.ok), [0, 1, 0])
                assert.strict.deepStrictEqual(evs.filter((v) => v.t === 'error').map((v) => v.err), [
                    'invalid id: string contains lone surrogate at [data[0].id]',
                    'invalid id: string contains lone surrogate at [data[2].id]',
                ])
            }
            finally {
                await wo.close()
            }
        })

        it('selectByPk孤立或含NUL之主鍵回null且不發error事件', async function() {
            let wo = freshBackend()
            try {
                await wo.insert({ id: 'a\uFFFD', name: 'fffd' })
                let n = 0
                wo.on('error', () => n++)
                assert.strict.equal(await wo.selectByPk(H), null)
                assert.strict.equal(await wo.selectByPk('a\u0000b'), null)
                assert.strict.equal(n, 0)
            }
            finally {
                await wo.close()
            }
        })

        it('已關閉之實例: 孤立主鍵仍回closed訊息(isClosed先於檢核)', async function() {
            let wo = freshBackend()
            await wo.close()
            for (let fn of ['insert', 'insertBulk', 'save', 'del']) {
                await assert.rejects(() => wo[fn]([mk(H)]), (err) => /closed/.test(msgOf(err)) && !/invalid id/.test(msgOf(err)), fn)
            }
            await assert.rejects(() => wo.selectByPk(H), (err) => /closed/.test(msgOf(err)))
        })

        it('建構時孤立代理於同步throw, 且不建立任何資料夾', function() {
            let url = `${root}/ctor-nocreate`
            assert.throws(() => WOrm({ url, db: 'd\uD800', cl: 'c' }), (err) => msgOf(err) === 'invalid opt.db: string contains lone surrogate')
            assert.throws(() => WOrm({ url, db: 'd', cl: 'c\uDC00' }), (err) => msgOf(err) === 'invalid opt.cl: string contains lone surrogate')
            assert.throws(() => WOrm({ url: `${url}\uD800`, db: 'd', cl: 'c' }), (err) => msgOf(err) === 'invalid opt.url: string contains lone surrogate')
            assert.strict.equal(fs.existsSync(url), false)
        })

        it('autoGenPk為true時未帶有效id之筆先補主鍵再檢核: 照常寫入; 其資料不合格者仍拒收(訊息為資料路徑)', async function() {
            for (let fn of ['insert', 'insertBulk', 'save']) {
                let wo = freshBackend()
                try {
                    let r = await wo[fn]([{ name: 'a' }, { id: '', name: 'b' }, { id: 12345, name: 'c' }])
                    if (fn === 'save') {
                        assert.strict.deepStrictEqual(r.map((v) => v.ok), [1, 1, 1], fn)
                    }
                    else {
                        assert.strict.equal(r.ok, 1, fn)
                    }
                    let rows = await wo.select()
                    assert.strict.equal(rows.length, 3, fn)
                    assert.strict.deepStrictEqual(rows.map((v) => v.name).sort(), ['a', 'b', 'c'], fn)
                    for (let x of rows) {
                        assert.strict.ok(typeof x.id === 'string' && x.id !== '' && x.id.isWellFormed(), fn)
                    }

                    //資料不合格: 主鍵已補(良構), 故訊息為資料路徑
                    if (fn === 'save') {
                        let rs = await wo.save([{ name: 'x\uD800' }])
                        assert.strict.equal(rs[0].err, 'invalid data: string contains lone surrogate at [data[0].name]', fn)
                    }
                    else {
                        await assert.rejects(() => wo[fn]([{ name: 'ok' }, { name: 'x\uD800' }]), (err) => msgOf(err) === 'invalid data: string contains lone surrogate at [data[1].name]', fn)
                    }
                }
                finally {
                    await wo.close()
                }
            }
        })

        it('Date範圍外與孤立代理並存: 先報Date(帳本R-DATE-01之既有行為不變), 兩者單獨存在時各自拒收', async function() {
            for (let fn of ['insert', 'insertBulk']) {
                let wo = freshBackend()
                try {
                    await assert.rejects(() => wo[fn]([{ id: 'x', t: new Date(8.64e15), name: 'a\uD800' }]), (err) => /^invalid data: Date year is out of range 0000-9999 at \[data\[0\]\.t\]$/.test(msgOf(err)), fn)
                    await assert.rejects(() => wo[fn]([{ id: 'x', t: new Date(0), name: 'a\uD800' }]), (err) => msgOf(err) === 'invalid data: string contains lone surrogate at [data[0].name]', fn)
                    await assert.rejects(() => wo[fn]([{ id: 'x', t: new Date(8.64e15), name: 'ok' }]), (err) => /^invalid data: Date year is out of range/.test(msgOf(err)), fn)
                    assert.strict.deepStrictEqual(await wo.select(), [], fn)
                }
                finally {
                    await wo.close()
                }
            }
        })

        it('單一物件(非陣列)呼叫之批次索引為data[0]', async function() {
            let wo = freshBackend()
            try {
                await assert.rejects(() => wo.insert(mk(H)), (err) => msgOf(err) === 'invalid id: string contains lone surrogate at [data[0].id]')
                let rs = await wo.save(mk(H))
                assert.strict.equal(rs[0].err, 'invalid id: string contains lone surrogate at [data[0].id]')
                let rd = await wo.del(mk(H))
                assert.strict.equal(rd[0].err, 'invalid id: string contains lone surrogate at [data[0].id]')
            }
            finally {
                await wo.close()
            }
        })

        it('del之非字串或空主鍵之訊息不回顯值, 含批次索引', async function() {
            let wo = freshBackend()
            try {
                let rd = await wo.del([{ id: 123456 }, { id: '' }, { name: 'noid' }, { id: { secret: 'S3CR3T' } }])
                assert.strict.deepStrictEqual(rd.map((v) => v.ok), [0, 0, 0, 0])
                for (let x of rd) {
                    assert.strict.ok(!/123456|S3CR3T|noid/.test(x.err), x.err)
                    assert.strict.ok(/^invalid id: .+ at \[data\[\d\]\.id\]$/.test(x.err), x.err)
                }
            }
            finally {
                await wo.close()
            }
        })

        it('良構之emoji、CJK擴充B區、U+FFFD主鍵與鍵名照常往返, 且與孤立形態之鄰近列互不影響', async function() {
            let wo = freshBackend()
            try {
                let okIds = ['a\u{1F600}', '\u{20BB7}野', 'a\uFFFD', 'a\uFFFD\uFFFD\uFFFD']
                await wo.insertBulk(okIds.map((id) => ({ id, name: id, [id]: id })))
                for (let id of okIds) {
                    let d = await wo.selectByPk(id)
                    assert.strict.deepStrictEqual(d, { id, name: id, [id]: id })
                }
                let rs = await wo.del([{ id: 'a\uD800' }, { id: 'a\u{1F600}' }])
                assert.strict.deepStrictEqual(rs.map((v) => v.ok), [0, 1])
                assert.strict.deepStrictEqual((await wo.select()).map((v) => v.id).sort(), ['a\uFFFD', 'a\uFFFD\uFFFD\uFFFD', '\u{20BB7}野'].sort())
            }
            finally {
                await wo.close()
            }
        })
    })

    describe('案例表契約', function() {
        it('forms與reasons詞彙存在(案例表契約)', function() {
            assert.strict.ok(Object.keys(forms).length >= 33)
            assert.strict.deepStrictEqual(Object.keys(reasons).sort(), ['lone', 'notStr', 'nul'])
        })
    })
})
