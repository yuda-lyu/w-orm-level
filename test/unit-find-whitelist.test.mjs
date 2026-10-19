import assert from 'assert'
import vm from 'vm'
import w from 'wsemi'
import { Level } from 'level'
import cvCases from 'wsemi/src/_cvOrmFindCases.mjs'
import cvOrmFind from 'wsemi/src/cvOrmFind.mjs'
import WOrm from '../src/WOrmLevel.mjs'
import { tick, mkObserver } from './lib/mkObserver.mjs'
import { leaves, chkSame } from './lib/leaves.mjs'


//條件(find)之系列白名單(帳本R-FIND-01; 規則: C:\opensrcOper\dspec\w-orm系列條件語法支援盤點.md〈一之三〉)
//共用檢核為wsemi之cvOrmFind, 契約案例表為wsemi之_cvOrmFindCases(各w-orm-*逐案對公開select與delAll執行, 每案以seed()重建),
//本檔驗證select與delAll確實於入口(serialize佇列之外)呼叫並只使用檢核後之複本, 而未被後端(mingo)略過
//level屬MongoDB式族, 命中集合取案例之ids.mongo; 數據以JSON存值, 故條件內之Date由本套件轉為ISO字串後方能命中(E05 C09 I17);
//本套件之$in上限即共用預設(10000), 故案例之need不使本套件reject
describe('find-whitelist', function() {
    let { seed, cases } = cvCases
    let url = './test/_tmp/find-whitelist'
    let dbName = 'worm'

    //ids, 取id集合(升冪)
    let ids = (rs) => rs.map((v) => v.id).sort()

    //directMsg, 共用檢核對同一條件直接給出之訊息(後端須原樣給出, 不得改寫、包裝或另立訊息)
    let directMsg = (f) => {
        try {
            cvOrmFind(f)
        }
        catch (err) {
            return err.message
        }
        return null
    }

    //reset, 清空後以seed()重建
    let reset = async(wo) => {
        await wo.delAll()
        await wo.insertBulk(seed())
    }

    //sortRows
    let sortRows = (rows) => rows.sort((a, b) => (a.id < b.id ? -1 : 1))

    //chkRej, 整批reject之共同斷言(WL-R1、WL-R3): 訊息以invalid find開頭且逐字等於共用檢核給出之訊息(expectMsg), error事件於reject前恰發出一次(訊息同reject), change不發
    let chkRej = (out, fn, expectMsg = null) => {
        assert.strict.equal(out.ok, false, `${fn} should reject`)
        assert.strict.ok(out.err instanceof Error, `${fn} should reject with Error`)
        assert.strict.ok(out.err.message.indexOf('invalid find: ') === 0, `${fn} message should start with 'invalid find: ' but got: ${out.err.message}`)
        if (expectMsg !== null) {
            assert.strict.equal(out.err.message, expectMsg, `${fn} message should be the one of cvOrmFind`)
        }
        let evErr = out.evs.filter((v) => v.t === 'error')
        let evChg = out.evs.filter((v) => v.t === 'change' && v.mode === fn) //只計本函數之change(佇列測試中同時排入之insertBulk會發出自己的change)
        assert.strict.equal(evErr.length, 1, `${fn} should emit error exactly once`)
        assert.strict.equal(out.nAtSettle, 1, `${fn} should emit error before reject`)
        assert.strict.equal(evErr[0].settledAtEmit, false, `${fn} should emit error before reject`)
        assert.strict.equal(evErr[0].mode, fn)
        assert.strict.equal(evErr[0].data, null)
        assert.strict.equal(evErr[0].err, out.err.message, `${fn} error event should carry the reject message`)
        assert.strict.equal(evChg.length, 0, `${fn} should not emit change`)
    }

    before(function() {
        w.fsDeleteFolder(url)
    })

    after(function() {
        w.fsDeleteFolder(url)
    })

    describe('cases', function() {
        let wo = null
        let ob = null
        let seedIds = ids(seed())
        let seedRows = null

        before(async function() {
            wo = WOrm({ url: `${url}/cases`, db: dbName, cl: 'cases' })
            ob = mkObserver(wo)
            await reset(wo)
            seedRows = sortRows(await wo.select())
        })

        after(async function() {
            await wo.close()
        })

        //案例表本身: 防案例表被替換為空表或缺組別而使下列逐案全綠成為假象
        it('should get nonempty case table covering all groups with seed of 6 rows', function() {
            let groups = [...new Set(cases.map((c) => c.group))].sort().join('')
            assert.strict.equal(groups, 'CEFHILNTVX')
            assert.strict.ok(cases.length >= 241)
            assert.strict.deepStrictEqual(seedIds, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
        })

        for (let c of cases) {

            if (c.expect === 'REJ') {

                //REJ案: select與delAll皆整批reject, 資料表不變(WL-02、WL-07等; 對應案例表expect=REJ)
                it(`should reject select and delAll without any change for ${c.id} ${c.label}`, async function() {
                    await reset(wo)
                    ob.clear()

                    let expectMsg = directMsg(c.find())
                    assert.strict.notEqual(expectMsg, null, 'cvOrmFind should reject the case')
                    let outS = await ob.invoke('select', c.find())
                    chkRej(outS, 'select', expectMsg)
                    let outD = await ob.invoke('delAll', c.find())
                    chkRej(outD, 'delAll', expectMsg)

                    //資料不變
                    assert.strict.deepStrictEqual(sortRows(await wo.select()), seedRows)
                })

            }
            else {

                //ALL與OK案: select命中ids.mongo; delAll刪除之集合等於select命中之集合(系列最低要求①), n與nDeleted為實際刪除筆數
                it(`should select ${JSON.stringify(c.ids.mongo)} and delAll the same set for ${c.id} ${c.label}`, async function() {
                    await reset(wo)
                    ob.clear()

                    let outS = await ob.invoke('select', c.find())
                    assert.strict.equal(outS.ok, true, `select should resolve but got: ${outS.err}`)
                    let sel = ids(outS.val)
                    assert.strict.deepStrictEqual(sel, c.ids.mongo)
                    assert.strict.equal(outS.evs.filter((v) => v.t === 'error').length, 0)

                    await reset(wo)
                    ob.clear()
                    let outD = await ob.invoke('delAll', c.find())
                    assert.strict.equal(outD.ok, true, `delAll should resolve but got: ${outD.err}`)
                    assert.strict.deepStrictEqual(outD.val, { n: sel.length, nDeleted: sel.length, ok: 1 })
                    assert.strict.equal(outD.evs.filter((v) => v.t === 'error').length, 0)

                    let rest = ids(await wo.select())
                    let deleted = seedIds.filter((id) => rest.indexOf(id) < 0)
                    assert.strict.deepStrictEqual(deleted, sel)
                })

            }

        }

    })

    //檢查之值即使用之值(WL-H4): 檢核回傳之複本即後續查詢與刪除所用之條件, 不得再讀呼叫端之原物件
    //以Proxy令欄位g於第1次讀取回'A'(檢核所讀)、其後回'B', 若後端改讀原物件(mingo以[]取值)則命中集合改變
    describe('copy', function() {
        let wo = null

        before(async function() {
            wo = WOrm({ url: `${url}/copy`, db: dbName, cl: 'copy' })
            await reset(wo)
        })

        after(async function() {
            await wo.close()
        })

        //mkFlip, 欄位g第1次被讀取(不論以屬性描述子或get)回'A', 其後回'B'; 同時回傳讀取次數
        let mkFlip = () => {
            let st = { n: 0 }
            let val = () => {
                st.n++
                return st.n === 1 ? 'A' : 'B'
            }
            let px = new Proxy({ g: 'A' }, {
                getOwnPropertyDescriptor(t, k) {
                    let d = Reflect.getOwnPropertyDescriptor(t, k)
                    if (k === 'g') {
                        d = { ...d, value: val() }
                    }
                    return d
                },
                get(t, k, r) {
                    if (k === 'g') {
                        return val()
                    }
                    return Reflect.get(t, k, r)
                },
            })
            return { px, st }
        }

        let shapes = {
            top: (px) => px,
            nested: (px) => ({ $or: [px] }),
        }

        for (let name of Object.keys(shapes)) {

            it(`should select by the checked value only for ${name} condition`, async function() {
                await reset(wo)
                let { px, st } = mkFlip()
                let r = await wo.select(shapes[name](px))
                assert.strict.deepStrictEqual(ids(r), ['a1', 'a2'])
                assert.strict.equal(st.n, 1, 'value should be read once')
            })

            it(`should delAll by the checked value only for ${name} condition`, async function() {
                await reset(wo)
                let { px, st } = mkFlip()
                let r = await wo.delAll(shapes[name](px))
                assert.strict.deepStrictEqual(r, { n: 2, nDeleted: 2, ok: 1 })
                assert.strict.deepStrictEqual(ids(await wo.select()), ['a3', 'a4', 'a5', 'a6'])
                assert.strict.equal(st.n, 1, 'value should be read once')
            })

        }

        //熱快取(useCache已填入)時亦只用檢核後之複本: 原快取測試只以壞條件與穩定條件驗快取, 守不住「合法條件改讀原物件」
        for (let fn of ['select', 'delAll']) {
            it(`should use the checked copy only with warm cache for ${fn}`, async function() {
                let wc = WOrm({ url: `${url}/warm${fn}`, db: dbName, cl: 'warm', useCache: true })
                await wc.insertBulk(seed())
                assert.strict.equal((await wc.select()).length, 6) //填入快取
                let { px, st } = mkFlip()
                if (fn === 'select') {
                    assert.strict.deepStrictEqual(ids(await wc.select(px)), ['a1', 'a2'])
                }
                else {
                    assert.strict.deepStrictEqual(await wc.delAll(px), { n: 2, nDeleted: 2, ok: 1 })
                    assert.strict.deepStrictEqual(ids(await wc.select()), ['a3', 'a4', 'a5', 'a6'])
                }
                assert.strict.equal(st.n, 1, 'value should be read once')
                await wc.close()
            })
        }

        //「是否有條件」之判斷亦須依檢核後之複本: ownKeys於第1次回['g']、其後回[](若改讀原物件, select會回全部、delAll會刪光)
        for (let fn of ['select', 'delAll']) {
            it(`should decide the empty condition by the checked copy only for ${fn}`, async function() {
                await reset(wo)
                let n = 0
                let px = new Proxy({ g: 'A' }, {
                    ownKeys() {
                        n++
                        return n === 1 ? ['g'] : []
                    },
                })
                if (fn === 'select') {
                    assert.strict.deepStrictEqual(ids(await wo.select(px)), ['a1', 'a2'])
                }
                else {
                    assert.strict.deepStrictEqual(await wo.delAll(px), { n: 2, nDeleted: 2, ok: 1 })
                    assert.strict.deepStrictEqual(ids(await wo.select()), ['a3', 'a4', 'a5', 'a6'])
                }
                assert.strict.equal(n, 1, 'ownKeys should be read once')
            })
        }

        //運算子物件內之值亦只讀一次並只用複本: {age:Proxy({$gt:20})}, $gt第1次被讀取回20、其後回100(若改讀原物件, 命中集合改變)
        for (let fn of ['select', 'delAll']) {
            it(`should read the value in operator object once for ${fn}`, async function() {
                await reset(wo)
                let n = 0
                let val = () => (++n === 1 ? 20 : 100)
                let op = new Proxy({ $gt: 20 }, {
                    getOwnPropertyDescriptor(t, k) {
                        let d = Reflect.getOwnPropertyDescriptor(t, k)
                        return k === '$gt' ? { ...d, value: val() } : d
                    },
                    get(t, k, r) {
                        return k === '$gt' ? val() : Reflect.get(t, k, r)
                    },
                })
                if (fn === 'select') {
                    assert.strict.deepStrictEqual(ids(await wo.select({ age: op })), ['a2', 'a3', 'a5'])
                }
                else {
                    assert.strict.deepStrictEqual(await wo.delAll({ age: op }), { n: 3, nDeleted: 3, ok: 1 })
                    assert.strict.deepStrictEqual(ids(await wo.select()), ['a1', 'a4', 'a6'])
                }
                assert.strict.equal(n, 1, 'value should be read once')
            })
        }

        //呼叫端的條件物件不被改動: 複本內之Date轉為ISO字串不得波及呼叫端之Date
        it('should not modify the find object of caller', async function() {
            await reset(wo)
            let find = { $and: [{ g: 'A' }, { age: { $in: [20, 30] } }], d: new Date(Date.UTC(2026, 0, 1)) }
            let snap = JSON.stringify(find)
            let d0 = find.d.getTime()
            let r = await wo.select(find)
            assert.strict.deepStrictEqual(ids(r), ['a1'])
            await wo.delAll(find)
            assert.strict.equal(JSON.stringify(find), snap)
            assert.strict.ok(find.d instanceof Date)
            assert.strict.equal(find.d.getTime(), d0)
            assert.strict.ok(Object.getPrototypeOf(find) === Object.prototype)
        })

        //select與delAll對同一條件之判定一致(逐案已驗, 此處以非空巢狀條件再驗一次)
        it('should delAll exactly what select returns for nested condition', async function() {
            await reset(wo)
            let find = { $or: [{ $and: [{ g: 'B' }, { age: { $gte: 40 } }] }, { id: { $in: ['a1'] } }] }
            let sel = ids(await wo.select(find))
            assert.strict.deepStrictEqual(sel, ['a1', 'a3', 'a5'])
            let r = await wo.delAll(find)
            assert.strict.deepStrictEqual(r, { n: 3, nDeleted: 3, ok: 1 })
            assert.strict.deepStrictEqual(ids(await wo.select()), ['a2', 'a4', 'a6'])
        })

    })

    //欄名同於Object.prototype成員(WL-F2: constructor、toString、hasOwnProperty、valueOf等為白名單內之合法欄名):
    //數據無此自有欄位者須與一般不存在之欄位同為缺欄(null語意), 不得取到繼承之成員(修正前mingo取到函數, {constructor:null}無命中、{constructor:{$ne:null}}命中全部而delAll刪光)
    describe('protoname', function() {
        let wo = null

        //resetP, 種子6列(皆無自有constructor、toString等欄)另加p1(自有constructor與toString欄)
        let resetP = async() => {
            await reset(wo)
            await wo.insert({ id: 'p1', constructor: 'own', toString: 'ts' })
        }
        let A6 = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']

        before(async function() {
            wo = WOrm({ url: `${url}/proto`, db: dbName, cl: 'proto' })
        })

        after(async function() {
            await wo.close()
        })

        let finds = [
            { name: '{constructor:null}', find: () => ({ constructor: null }), ids: A6 },
            { name: '{constructor:{$eq:null}}', find: () => ({ constructor: { $eq: null } }), ids: A6 },
            { name: '{constructor:{$ne:null}}', find: () => ({ constructor: { $ne: null } }), ids: ['p1'] },
            { name: '{constructor:"own"}', find: () => ({ constructor: 'own' }), ids: ['p1'] },
            { name: '{toString:{$ne:null}}', find: () => ({ toString: { $ne: null } }), ids: ['p1'] },
            { name: '{toString:null}', find: () => ({ toString: null }), ids: A6 },
            { name: '{hasOwnProperty:{$ne:null}}', find: () => ({ hasOwnProperty: { $ne: null } }), ids: [] },
            { name: '{valueOf:null}', find: () => ({ valueOf: null }), ids: [...A6, 'p1'] },
            { name: '{valueOf:{$in:["x"]}}', find: () => ({ valueOf: { $in: ['x'] } }), ids: [] },
            { name: '{valueOf:{$nin:["x"]}}', find: () => ({ valueOf: { $nin: ['x'] } }), ids: [...A6, 'p1'] },
            { name: '$or', find: () => ({ $or: [{ constructor: 'own' }, { id: 'a1' }] }), ids: ['a1', 'p1'] },
            { name: '$and', find: () => ({ $and: [{ toString: null }, { id: 'a2' }] }), ids: ['a2'] },
            { name: 'nested $or in $and', find: () => ({ $and: [{ $or: [{ hasOwnProperty: { $ne: null } }, { id: 'a3' }] }] }), ids: ['a3'] },
            { name: 'with ordinary field', find: () => ({ g: 'A', constructor: null }), ids: ['a1', 'a2'] },
        ]
        for (let f of finds) {
            it(`should select and delAll by ${f.name} as missing-field semantics`, async function() {
                await resetP()
                assert.strict.deepStrictEqual(ids(await wo.select(f.find())), f.ids)
                await resetP()
                let r = await wo.delAll(f.find())
                assert.strict.deepStrictEqual(r, { n: f.ids.length, nDeleted: f.ids.length, ok: 1 })
                let rest = ids(await wo.select())
                assert.strict.deepStrictEqual([...A6, 'p1'].filter((id) => rest.indexOf(id) < 0), f.ids)
            })
        }

        //對照組: 一般不存在之欄位(全部列皆缺欄)之語意, 原型成員欄名須與之同(數據無自有欄位者皆缺欄)
        it('should get the same result for an ordinary missing field', async function() {
            await resetP()
            assert.strict.deepStrictEqual(ids(await wo.select({ nocolumn: null })), [...A6, 'p1'])
            assert.strict.deepStrictEqual(ids(await wo.select({ nocolumn: { $ne: null } })), [])
            assert.strict.deepStrictEqual(ids(await wo.select({ nocolumn: { $nin: ['x'] } })), [...A6, 'p1'])
            assert.strict.deepStrictEqual(ids(await wo.select({ nocolumn: { $in: ['x'] } })), [])
        })

    })

    //Date(WL-S3): 數據以JSON存值(Date成ISO字串), 條件內之Date由本套件於轉譯層轉為ISO字串, 於各位置皆須命中
    describe('date', function() {
        let wo = null
        let D1 = () => new Date(Date.UTC(2026, 0, 1))
        let D2 = () => new Date(Date.UTC(2026, 1, 1))

        before(async function() {
            wo = WOrm({ url: `${url}/date`, db: dbName, cl: 'date' })
            await reset(wo)
        })

        after(async function() {
            await wo.close()
        })

        it('should get ISO string of Date in stored rows', async function() {
            await reset(wo)
            let a1 = (await wo.selectByPk('a1'))
            assert.strict.equal(a1.d, '2026-01-01T00:00:00.000Z')
        })

        let finds = [
            { name: '$eq', find: () => ({ d: { $eq: D1() } }), ids: ['a1'] },
            { name: '$ne', find: () => ({ d: { $ne: D1() } }), ids: ['a2', 'a3', 'a4', 'a5', 'a6'] },
            { name: '$gt', find: () => ({ d: { $gt: D1() } }), ids: ['a2'] },
            { name: '$lt', find: () => ({ d: { $lt: D2() } }), ids: ['a1'] },
            { name: '$lte', find: () => ({ d: { $lte: D2() } }), ids: ['a1', 'a2'] },
            { name: '$in', find: () => ({ d: { $in: [D2()] } }), ids: ['a2'] },
            { name: '$nin', find: () => ({ d: { $nin: [D1(), D2()] } }), ids: ['a3', 'a4', 'a5', 'a6'] },
            { name: '$or', find: () => ({ $or: [{ d: D2() }, { id: 'a3' }] }), ids: ['a2', 'a3'] },
            { name: '$and', find: () => ({ $and: [{ d: { $gte: D1() } }, { d: { $lte: D1() } }] }), ids: ['a1'] },
            { name: 'range', find: () => ({ d: { $gte: D1(), $lte: D2() } }), ids: ['a1', 'a2'] },
        ]
        for (let f of finds) {
            it(`should select and delAll by Date in ${f.name}`, async function() {
                await reset(wo)
                assert.strict.deepStrictEqual(ids(await wo.select(f.find())), f.ids)
                let r = await wo.delAll(f.find())
                assert.strict.deepStrictEqual(r, { n: f.ids.length, nDeleted: f.ids.length, ok: 1 })
                let rest = ids(await wo.select())
                assert.strict.deepStrictEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].filter((id) => rest.indexOf(id) < 0), f.ids)
            })
        }

    })

    //時序(入口順序為closed→find檢核→讀取; find檢核置於serialize佇列之外)
    describe('order', function() {
        let bad = () => ({ $where: () => true })

        //已關閉先於find檢核: 以壞條件呼叫已關閉之實例, 訊息須為closed而非invalid find
        it('should reject with closed message before find check for closed instance', async function() {
            let wo = WOrm({ url: `${url}/closed`, db: dbName, cl: 'closed' })
            await wo.insert({ id: 'x1', g: 'A' })
            await wo.close()
            let ob = mkObserver(wo)
            for (let fn of ['select', 'delAll']) {
                let out = await ob.invoke(fn, bad())
                assert.strict.equal(out.ok, false)
                assert.strict.equal(out.err.message, `can not ${fn} by closed client, instance can not be used after close()`)
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1)
                assert.strict.equal(evErr[0].err, out.err.message)
            }
        })

        //serialize佇列: 壞條件於佇列之外立即reject, 不等候先前已排入佇列之操作, 且不使其後之呼叫失敗
        it('should reject bad find before queued operations finish and keep queue working', async function() {
            let wo = WOrm({ url: `${url}/queue`, db: dbName, cl: 'queue' })
            let ob = mkObserver(wo)
            await reset(wo)
            let rows = []
            for (let i = 0; i < 2000; i++) {
                rows.push({ id: `q${i}`, g: 'Q', v: i })
            }
            for (let fn of ['select', 'delAll']) {
                let done = false
                let pmBig = wo.insertBulk(rows.map((v) => ({ ...v, id: `${fn}-${v.id}` }))).then(function(r) {
                    done = true
                    return r
                })
                let out = await ob.invoke(fn, bad(), () => done)
                chkRej(out, fn)
                assert.strict.equal(out.probe, false, `${fn} should reject before the queued insertBulk finishes`)
                let rBulk = await pmBig
                assert.strict.equal(rBulk.nInserted, 2000)
            }
            //佇列不受影響
            assert.strict.deepStrictEqual(ids(await wo.select({ id: 'a1' })), ['a1'])
            let r = await wo.delAll({ g: 'Q' })
            assert.strict.deepStrictEqual(r, { n: 4000, nDeleted: 4000, ok: 1 })
            assert.strict.deepStrictEqual(ids(await wo.select()), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
            await wo.close()
        })

        //useCache: 快取已填入時壞條件仍須reject, 快取與資料不受影響
        it('should reject bad find with filled cache and keep data', async function() {
            let wo = WOrm({ url: `${url}/cache`, db: dbName, cl: 'cache', useCache: true })
            let ob = mkObserver(wo)
            await wo.insertBulk(seed())
            assert.strict.equal((await wo.select()).length, 6)
            for (let fn of ['select', 'delAll']) {
                for (let f of [bad(), null, [], { g: undefined }, { g: { $nin: [] } }]) {
                    let out = await ob.invoke(fn, f)
                    chkRej(out, fn, directMsg(f))
                }
            }
            assert.strict.deepStrictEqual(ids(await wo.select()), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
            assert.strict.deepStrictEqual(ids(await wo.select({ g: 'A' })), ['a1', 'a2'])
            await wo.close()
        })

        //關閉進行中(close()已呼叫而尚未await, status為closing)亦屬已關閉: 以壞條件呼叫須回closed訊息, 不得回invalid find
        it('should reject with closed message before find check while closing', async function() {
            for (let fn of ['select', 'delAll']) {
                let wo = WOrm({ url: `${url}/closing${fn}`, db: dbName, cl: 'closing' })
                await wo.insert({ id: 'x1', g: 'A' })
                let ob = mkObserver(wo)
                let pmClose = wo.close()
                await tick() //level之close排入serialize佇列, 讓出後方進入closing(其後為closed, 二者皆屬已關閉)
                let out = await ob.invoke(fn, bad())
                assert.strict.equal(out.ok, false)
                assert.strict.equal(out.err.message, `can not ${fn} by closed client, instance can not be used after close()`)
                await pmClose
            }
        })

        //檢核途中實例被關閉(條件內之Proxy trap呼叫close後拋錯): 兩函數皆須保留檢核產生之invalid find, 不得被改寫為closed訊息
        it('should keep invalid find when instance is closed during find check', async function() {
            for (let fn of ['select', 'delAll']) {
                let wo = WOrm({ url: `${url}/closeduring${fn}`, db: dbName, cl: 'during' })
                await wo.insert({ id: 'x1', g: 'A' })
                let ob = mkObserver(wo)
                let pmClose = null
                let px = new Proxy({ g: 'A' }, {
                    ownKeys() {
                        pmClose = wo.close()
                        throw new Error('PRIVATE_TRAP_ERROR')
                    },
                })
                let out = await ob.invoke(fn, px)
                chkRej(out, fn)
                assert.strict.ok(out.err.message.indexOf('PRIVATE_TRAP_ERROR') < 0, 'message should not echo the error of caller')
                assert.strict.ok(out.err.message.indexOf('closed') < 0, 'message should not be rewritten as closed')
                await pmClose
            }
        })

        //find檢核先於讀取: 資料庫內有無法解碼之紀錄(任何讀取皆拋解碼錯誤)時, 壞條件仍須回invalid find(未讀取), 合法條件則因讀取而回解碼錯誤
        it('should check find before reading the database', async function() {
            let urlBad = `${url}/unreadable`
            let raw = new Level(`${urlBad}/${dbName}/un`, { valueEncoding: 'buffer' })
            await raw.put('bad', Buffer.from('{ invalid JSON'))
            await raw.close()

            let wo = WOrm({ url: urlBad, db: dbName, cl: 'un' })
            let ob = mkObserver(wo)

            //對照: 合法條件須讀取資料庫, 因解碼錯誤而reject, 且訊息不是invalid find
            for (let fn of ['select', 'delAll']) {
                let out = await ob.invoke(fn, { g: 'A' })
                assert.strict.equal(out.ok, false, `${fn} with valid find should reject by unreadable record`)
                assert.strict.ok(out.err.message.indexOf('invalid find') < 0, `${fn} valid find should not get invalid find: ${out.err.message}`)
            }

            //壞條件: 於讀取之前reject
            for (let fn of ['select', 'delAll']) {
                for (let f of [bad(), null, [], { g: undefined }, { $and: [] }]) {
                    let out = await ob.invoke(fn, f)
                    chkRej(out, fn, directMsg(f))
                }
            }
            await wo.close()
        })

    })

    //範圍外Date條件fail-closed(帳本R-FIND-02): 數據以JSON存值, Date條件轉ISO字串後以字典序比較, 年份介於0000-9999時為固定24字元, 字典序即時間序;
    //年份<0或>9999時toISOString()帶+yyyyyy-/-yyyyyy-前綴, 字典序與時間序顛倒, 故轉譯層對此類條件值整批reject(訊息格式同cvOrmFind, 不回顯值), select與delAll皆同, 於任何讀取之前
    describe('date-range', function() {
        let MS = {
            min: -62167219200000, //0000-01-01T00:00:00.000Z
            max: 253402300799999, //9999-12-31T23:59:59.999Z
            belowMin: -62167219200001, //-000001-12-31T23:59:59.999Z
            aboveMax: 253402300800000, //+010000-01-01T00:00:00.000Z
            big: 8.64e15, //+275760-09-13T00:00:00.000Z
            small: -8.64e15, //-271821-04-20T00:00:00.000Z
        }
        let D = (ms) => new Date(ms)
        let ok = () => D(Date.UTC(2026, 5, 1))
        let wo = null
        let ob = null
        let baseRows = null

        //rowsDr, 皆為範圍內之Date(r3、r4為邊界)
        let rowsDr = () => [
            { id: 'r1', t: D(Date.UTC(2020, 0, 1)) },
            { id: 'r2', t: D(Date.UTC(2099, 0, 1)) },
            { id: 'r3', t: D(MS.min) },
            { id: 'r4', t: D(MS.max) },
            { id: 'r5' },
        ]

        //resetDr
        let resetDr = async(w0) => {
            await w0.delAll()
            await w0.insertBulk(rowsDr())
        }

        //expectMsg, 本層之訊息(格式同cvOrmFind: invalid find: 原因 at [路徑])
        let expectMsg = (path) => `invalid find: Date year is out of range 0000-9999 at [${path}]`

        before(async function() {
            wo = WOrm({ url: `${url}/daterange`, db: dbName, cl: 'daterange' })
            ob = mkObserver(wo)
            await resetDr(wo)
            baseRows = sortRows(await wo.select())
        })

        after(async function() {
            await wo.close()
        })

        it('should store Date at the boundaries as fixed 24-char ISO strings', async function() {
            await resetDr(wo)
            assert.strict.equal((await wo.selectByPk('r3')).t, '0000-01-01T00:00:00.000Z')
            assert.strict.equal((await wo.selectByPk('r4')).t, '9999-12-31T23:59:59.999Z')
        })

        //接受: 邊界(0000-01-01T00:00:00.000Z、9999-12-31T23:59:59.999Z)內之Date, 命中集合正確且delAll刪除之集合等於select命中之集合
        let accepts = [
            { name: 'direct min', find: () => ({ t: D(MS.min) }), ids: ['r3'] },
            { name: 'direct max', find: () => ({ t: D(MS.max) }), ids: ['r4'] },
            { name: '$eq min', find: () => ({ t: { $eq: D(MS.min) } }), ids: ['r3'] },
            { name: '$ne min', find: () => ({ t: { $ne: D(MS.min) } }), ids: ['r1', 'r2', 'r4', 'r5'] },
            { name: '$gte min', find: () => ({ t: { $gte: D(MS.min) } }), ids: ['r1', 'r2', 'r3', 'r4'] },
            { name: '$gt min', find: () => ({ t: { $gt: D(MS.min) } }), ids: ['r1', 'r2', 'r4'] },
            { name: '$lt min', find: () => ({ t: { $lt: D(MS.min) } }), ids: [] },
            { name: '$lte min', find: () => ({ t: { $lte: D(MS.min) } }), ids: ['r3'] },
            { name: '$gt max', find: () => ({ t: { $gt: D(MS.max) } }), ids: [] },
            { name: '$gte max', find: () => ({ t: { $gte: D(MS.max) } }), ids: ['r4'] },
            { name: '$lt max', find: () => ({ t: { $lt: D(MS.max) } }), ids: ['r1', 'r2', 'r3'] },
            { name: '$lte max', find: () => ({ t: { $lte: D(MS.max) } }), ids: ['r1', 'r2', 'r3', 'r4'] },
            { name: '$in min and max', find: () => ({ t: { $in: [D(MS.min), D(MS.max)] } }), ids: ['r3', 'r4'] },
            { name: '$nin min and max', find: () => ({ t: { $nin: [D(MS.min), D(MS.max)] } }), ids: ['r1', 'r2', 'r5'] },
            { name: '$and from min to max', find: () => ({ $and: [{ t: { $gte: D(MS.min) } }, { t: { $lte: D(MS.max) } }] }), ids: ['r1', 'r2', 'r3', 'r4'] },
            { name: '$or min or max', find: () => ({ $or: [{ t: D(MS.min) }, { t: D(MS.max) }] }), ids: ['r3', 'r4'] },
            { name: '$lt now keeps in-range past rows only', find: () => ({ t: { $lt: new Date() } }), ids: ['r1', 'r3'] },
        ]
        for (let f of accepts) {
            it(`should select and delAll the same set by Date in range for ${f.name}`, async function() {
                await resetDr(wo)
                ob.clear()
                let outS = await ob.invoke('select', f.find())
                assert.strict.equal(outS.ok, true, `select should resolve but got: ${outS.err}`)
                assert.strict.deepStrictEqual(ids(outS.val), f.ids)
                assert.strict.equal(outS.evs.filter((v) => v.t === 'error').length, 0)
                let outD = await ob.invoke('delAll', f.find())
                assert.strict.equal(outD.ok, true, `delAll should resolve but got: ${outD.err}`)
                assert.strict.deepStrictEqual(outD.val, { n: f.ids.length, nDeleted: f.ids.length, ok: 1 })
                assert.strict.equal(outD.evs.filter((v) => v.t === 'error').length, 0)
                let rest = ids(await wo.select())
                assert.strict.deepStrictEqual(['r1', 'r2', 'r3', 'r4', 'r5'].filter((id) => rest.indexOf(id) < 0), f.ids)
            })
        }

        //接受: 範圍內但非端點之Date(端點內側1毫秒、年份交界、一般值), 以真實時間序為期望(範圍內字典序即時間序), 各運算子交叉select與delAll
        let inners = [
            '0000-01-01T00:00:00.001Z',
            '0000-12-31T23:59:59.999Z',
            '0001-01-01T00:00:00.000Z',
            '0999-12-31T23:59:59.999Z',
            '1970-01-01T00:00:00.000Z',
            '9998-12-31T23:59:59.999Z',
            '9999-01-01T00:00:00.000Z',
            '9999-12-31T23:59:59.998Z',
        ]
        let opsInner = [
            { name: '$eq', mk: (v) => ({ t: { $eq: v } }), hit: (a, b) => a === b, miss: false },
            { name: 'direct', mk: (v) => ({ t: v }), hit: (a, b) => a === b, miss: false },
            { name: '$ne', mk: (v) => ({ t: { $ne: v } }), hit: (a, b) => a !== b, miss: true },
            { name: '$gt', mk: (v) => ({ t: { $gt: v } }), hit: (a, b) => a > b, miss: false },
            { name: '$gte', mk: (v) => ({ t: { $gte: v } }), hit: (a, b) => a >= b, miss: false },
            { name: '$lt', mk: (v) => ({ t: { $lt: v } }), hit: (a, b) => a < b, miss: false },
            { name: '$lte', mk: (v) => ({ t: { $lte: v } }), hit: (a, b) => a <= b, miss: false },
            { name: '$in', mk: (v) => ({ t: { $in: [D(MS.min), v] } }), hit: (a, b) => a === b || a === MS.min, miss: false },
            { name: '$nin', mk: (v) => ({ t: { $nin: [v, D(MS.max)] } }), hit: (a, b) => a !== b && a !== MS.max, miss: true },
        ]
        for (let iso of inners) {
            it(`should accept Date ${iso} in every operator and give the time-ordered set in select and delAll`, async function() {
                let v = new Date(iso)
                assert.strict.equal(v.toISOString(), iso)
                for (let op of opsInner) {
                    let rows = [...rowsDr(), { id: 'x', t: new Date(iso) }]
                    let expect = rows.filter((r) => (r.t ? op.hit(r.t.getTime(), v.getTime()) : op.miss)).map((r) => r.id).sort()
                    for (let fn of ['select', 'delAll']) {
                        await wo.delAll()
                        await wo.insertBulk(rows)
                        ob.clear()
                        let out = await ob.invoke(fn, op.mk(new Date(iso)))
                        assert.strict.equal(out.ok, true, `${fn} ${op.name} should resolve but got: ${out.err}`)
                        assert.strict.equal(out.evs.filter((e) => e.t === 'error').length, 0)
                        if (fn === 'select') {
                            assert.strict.deepStrictEqual(ids(out.val), expect, `select ${op.name} ${iso}`)
                        }
                        else {
                            assert.strict.deepStrictEqual(out.val, { n: expect.length, nDeleted: expect.length, ok: 1 }, `delAll ${op.name} ${iso}`)
                            let rest = ids(await wo.select())
                            assert.strict.deepStrictEqual(rows.map((r) => r.id).sort().filter((id) => rest.indexOf(id) < 0), expect, `delAll set ${op.name} ${iso}`)
                        }
                    }
                }
            })
        }

        //reject: 範圍外Date於各位置, select與delAll皆整批reject, 訊息含路徑且不回顯值, error事件於reject前恰一次, 不發change, 資料不變
        let bads = [
            { name: 'below 0000 (-000001-12-31T23:59:59.999Z)', ms: MS.belowMin, echo: ['000001'] },
            { name: 'above 9999 (+010000-01-01T00:00:00.000Z)', ms: MS.aboveMax, echo: ['010000'] },
            { name: 'new Date(8.64e15)', ms: MS.big, echo: ['275760'] },
            { name: 'new Date(-8.64e15)', ms: MS.small, echo: ['271821'] },
        ]
        let positions = [
            { name: 'direct', find: (d) => ({ t: d }), path: 'find.t' },
            { name: 'direct in other field', find: (d) => ({ id: 'r1', u: d }), path: 'find.u' },
            { name: '$eq', find: (d) => ({ t: { $eq: d } }), path: 'find.t.$eq' },
            { name: '$ne', find: (d) => ({ t: { $ne: d } }), path: 'find.t.$ne' },
            { name: '$gt', find: (d) => ({ t: { $gt: d } }), path: 'find.t.$gt' },
            { name: '$gte', find: (d) => ({ t: { $gte: d } }), path: 'find.t.$gte' },
            { name: '$lt', find: (d) => ({ t: { $lt: d } }), path: 'find.t.$lt' },
            { name: '$lte', find: (d) => ({ t: { $lte: d } }), path: 'find.t.$lte' },
            { name: '$in first', find: (d) => ({ t: { $in: [d, ok()] } }), path: 'find.t.$in[0]' },
            { name: '$in middle', find: (d) => ({ t: { $in: [ok(), d, ok()] } }), path: 'find.t.$in[1]' },
            { name: '$in last', find: (d) => ({ t: { $in: [ok(), ok(), d] } }), path: 'find.t.$in[2]' },
            { name: '$nin', find: (d) => ({ t: { $nin: [ok(), d] } }), path: 'find.t.$nin[1]' },
            { name: '$and', find: (d) => ({ $and: [{ id: 'r1' }, { t: { $lt: d } }] }), path: 'find.$and[1].t.$lt' },
            { name: '$or', find: (d) => ({ $or: [{ t: d }, { id: 'r1' }] }), path: 'find.$or[0].t' },
            { name: '$and and $or nested', find: (d) => ({ $and: [{ $or: [{ id: 'r1' }, { $and: [{ t: { $gte: ok() } }, { t: { $lte: d } }] }] }] }), path: 'find.$and[0].$or[1].$and[1].t.$lte' },
            { name: 'range with valid Date sibling', find: (d) => ({ id: 'r1', t: { $gte: ok(), $lte: d } }), path: 'find.t.$lte' },
            { name: 'valid Date before and after', find: (d) => ({ a: ok(), t: d, z: ok() }), path: 'find.t' },
            { name: '$nin first', find: (d) => ({ t: { $nin: [d, ok()] } }), path: 'find.t.$nin[0]' },
            { name: '$nin middle', find: (d) => ({ t: { $nin: [ok(), d, ok()] } }), path: 'find.t.$nin[1]' },
            { name: '$nin last of three', find: (d) => ({ t: { $nin: [ok(), ok(), d] } }), path: 'find.t.$nin[2]' },
            { name: '$in at two-digit index', find: (d) => ({ t: { $in: [...Array.from({ length: 10 }, () => ok()), d, ok()] } }), path: 'find.t.$in[10]' },
            { name: '$and first branch', find: (d) => ({ $and: [{ t: { $lt: d } }, { id: 'r1' }] }), path: 'find.$and[0].t.$lt' },
            { name: '$or last branch', find: (d) => ({ $or: [{ id: 'r1' }, { t: d }] }), path: 'find.$or[1].t' },
            { name: '$or in $and in $or', find: (d) => ({ $or: [{ id: 'r2' }, { $and: [{ id: 'r1' }, { $or: [{ id: 'r3' }, { t: { $eq: d } }] }] }] }), path: 'find.$or[1].$and[1].$or[1].t.$eq' },
            { name: 'range in reverse order', find: (d) => ({ id: 'r1', t: { $lte: d, $gte: ok() } }), path: 'find.t.$lte' },
            { name: 'two out-of-range Date in different fields', find: (d) => ({ a: d, b: d }), path: 'find.a' },
            { name: 'two out-of-range Date in one $in', find: (d) => ({ t: { $in: [ok(), d, d] } }), path: 'find.t.$in[1]' },
        ]
        for (let b of bads) {
            for (let p of positions) {
                it(`should reject select and delAll without any change for ${b.name} in ${p.name}`, async function() {
                    await resetDr(wo)
                    ob.clear()
                    let d = D(b.ms)
                    let f = p.find(d)
                    let msg = expectMsg(p.path)
                    let before = leaves(f)

                    //cvOrmFind本身接受(證明本檢核屬轉譯層, 非共用檢核)
                    assert.strict.equal(directMsg(p.find(D(b.ms))), null, 'cvOrmFind should accept the Date')

                    //兩次呼叫皆傳入同一個f, reject後f逐節點(參照、毫秒、鍵序)須與呼叫前相同
                    for (let fn of ['select', 'delAll']) {
                        let out = await ob.invoke(fn, f)
                        chkRej(out, fn, msg)
                        for (let s of b.echo) {
                            assert.strict.ok(out.err.message.indexOf(s) < 0, `${fn} message should not echo the value: ${out.err.message}`)
                        }
                        chkSame(before, leaves(f))
                    }
                    assert.strict.equal(d.getTime(), b.ms)
                    assert.strict.ok(d instanceof Date)

                    //資料不變
                    assert.strict.deepStrictEqual(sortRows(await wo.select()), baseRows)
                })
            }
        }

        //字典序顛倒之場景(修正前: 範圍外Date轉為+yyyyyy-/-yyyyyy-字串後, '2020-…'等較大, 故$gt哨兵命中所有帶日期之數據, delAll因而刪光)
        let inverted = [
            { name: '$gt new Date(8.64e15)', find: () => ({ t: { $gt: D(MS.big) } }) },
            { name: '$gte new Date(8.64e15)', find: () => ({ t: { $gte: D(MS.big) } }) },
            { name: '$lt new Date(8.64e15)', find: () => ({ t: { $lt: D(MS.big) } }) },
            { name: '$lte new Date(8.64e15)', find: () => ({ t: { $lte: D(MS.big) } }) },
            { name: '$gt year 10000', find: () => ({ t: { $gt: D(MS.aboveMax) } }) },
            { name: '$lt year -1', find: () => ({ t: { $lt: D(MS.belowMin) } }) },
            { name: '$ne new Date(8.64e15)', find: () => ({ t: { $ne: D(MS.big) } }) },
            { name: '$nin [new Date(8.64e15)]', find: () => ({ t: { $nin: [D(MS.big)] } }) },
        ]
        for (let f of inverted) {
            it(`should not select or delete any row for ${f.name}`, async function() {
                await resetDr(wo)
                ob.clear()
                for (let fn of ['select', 'delAll']) {
                    let out = await ob.invoke(fn, f.find())
                    chkRej(out, fn)
                    assert.strict.ok(out.err.message.indexOf('out of range') >= 0, out.err.message)
                }
                assert.strict.deepStrictEqual(sortRows(await wo.select()), baseRows)
            })
        }

        //cvOrmFind自身之reject先於本檢核(同一條件同時含範圍外Date與白名單外運算子, 訊息須為cvOrmFind給出者)
        it('should keep the message of cvOrmFind when the find has other invalid parts', async function() {
            await resetDr(wo)
            let mk = () => ({ u: D(MS.big), v: { $regex: 'x' } })
            let expect = directMsg(mk())
            assert.strict.notEqual(expect, null)
            assert.strict.ok(expect.indexOf('out of range') < 0)
            for (let fn of ['select', 'delAll']) {
                let out = await ob.invoke(fn, mk())
                chkRej(out, fn, expect)
            }
            assert.strict.deepStrictEqual(sortRows(await wo.select()), baseRows)
        })

        //無效Date仍由cvOrmFind給出其訊息(不因本檢核改變)
        it('should keep the message of cvOrmFind for invalid Date', async function() {
            await resetDr(wo)
            let mk = () => ({ t: { $lt: new Date(NaN) } })
            let expect = directMsg(mk())
            assert.strict.ok(expect.indexOf('invalid Date') >= 0)
            for (let fn of ['select', 'delAll']) {
                let out = await ob.invoke(fn, mk())
                chkRej(out, fn, expect)
            }
        })

        //Date之各種形態: 子類別實例、實例自訂toISOString(回範圍內字串)、跨realm(vm)之Date、實例自訂Symbol.toStringTag, 範圍外者一律reject;
        //共用檢核複製為新Date後才轉字串, 故檢查之值即使用之值, 不受呼叫端之實例方法影響
        class SubDate extends Date {}
        let forms = [
            { name: 'subclass instance', mk: (ms) => new SubDate(ms) },
            { name: 'own toISOString returning an in-range string', mk: (ms) => { let d = D(ms); d.toISOString = () => '2020-01-01T00:00:00.000Z'; return d } },
            { name: 'own getTime returning an in-range value', mk: (ms) => { let d = D(ms); d.getTime = () => 0; return d } },
            { name: 'Date of another realm', mk: (ms) => vm.runInNewContext(`new Date(${ms})`) },
            { name: 'own Symbol.toStringTag', mk: (ms) => { let d = D(ms); d[Symbol.toStringTag] = 'X'; return d } },
        ]
        for (let form of forms) {
            it(`should reject out-of-range Date given as ${form.name}`, async function() {
                await resetDr(wo)
                for (let ms of [MS.big, MS.aboveMax, MS.belowMin, MS.small]) {
                    let direct = directMsg({ t: { $lt: form.mk(ms) } })
                    let msg = direct === null ? expectMsg('find.t.$lt') : direct
                    for (let fn of ['select', 'delAll']) {
                        let out = await ob.invoke(fn, { t: { $lt: form.mk(ms) } })
                        chkRej(out, fn, msg)
                    }
                }
                assert.strict.deepStrictEqual(sortRows(await wo.select()), baseRows)

                //範圍內者仍照常命中
                assert.strict.deepStrictEqual(ids(await wo.select({ t: { $lte: form.mk(MS.min) } })), ['r3'])
            })
        }

        //路徑格式: 訊息之路徑須逐字等於cvOrmFind對同一結構給出之路徑(以undefined取代Date令cvOrmFind給出其路徑), 含單鍵>30字元之截短、
        //截斷處切開代理對、全路徑>120字元之截短與恰為120之邊界
        let nest = (n, inner) => {
            let f = inner
            for (let i = 0; i < n; i++) {
                f = { $and: [f] }
            }
            return f
        }
        let pathOf = (msg) => msg.slice(msg.indexOf(' at [') + 5, -1)
        let pathCases = [
            { name: 'key of 30 chars', mk: (v) => ({ [`${'k'.repeat(30)}`]: { $lt: v } }) },
            { name: 'key of 31 chars', mk: (v) => ({ [`${'k'.repeat(31)}`]: { $lt: v } }) },
            { name: 'key of 128 chars', mk: (v) => ({ [`${'b'.repeat(128)}`]: v }) },
            { name: 'key cut inside a surrogate pair', mk: (v) => ({ [`${'a'.repeat(29)}\u{20000}zz`]: { $gt: v } }) },
            { name: 'key with astral letter fully inside 30 chars', mk: (v) => ({ [`${'a'.repeat(27)}\u{20000}`]: { $gt: v } }) },
            { name: 'non-ASCII key', mk: (v) => ({ 欄位: { $in: [v] } }) },
            { name: 'path of 114 chars', mk: (v) => nest(13, { t: { $lt: v } }) },
            { name: 'path of exactly 120 chars', mk: (v) => nest(13, { [`${'k'.repeat(11)}`]: v }) },
            { name: 'path of 121 chars', mk: (v) => nest(13, { [`${'k'.repeat(12)}`]: v }) },
            { name: 'path of 122 chars', mk: (v) => nest(14, { t: { $lt: v } }) },
            { name: 'path of 200 chars with long key', mk: (v) => nest(20, { [`${'k'.repeat(40)}`]: { $lte: v } }) },
        ]
        for (let c of pathCases) {
            it(`should give the same path as cvOrmFind for ${c.name}`, async function() {
                await resetDr(wo)
                let direct = directMsg(c.mk(undefined))
                assert.strict.notEqual(direct, null, 'cvOrmFind should reject the structure with undefined')
                let path = pathOf(direct)
                for (let ms of [MS.big, MS.belowMin]) {
                    for (let fn of ['select', 'delAll']) {
                        let out = await ob.invoke(fn, c.mk(D(ms)))
                        chkRej(out, fn, expectMsg(path))
                    }
                }
            })
        }

        //數據側(R-FIND-02規則5; 寫入側見R-DATE-01與unit-date-write): 資料庫內既有之範圍外Date字串(舊版寫入之樣子; 現行寫入已拒收範圍外Date物件,
        //惟字串不是Date物件故仍可寫入)無法以Date條件正確比較(文件已載明)
        it('should document that out-of-range Date strings already in database can not be compared by Date condition', async function() {
            let w1 = WOrm({ url: `${url}/daterange-data`, db: dbName, cl: 'data' })
            await w1.insertBulk([
                { id: 's1', t: '+275760-09-13T00:00:00.000Z' }, //舊版以new Date(8.64e15)寫入之樣子
                { id: 's2', t: '-271821-04-20T00:00:00.000Z' }, //舊版以new Date(-8.64e15)寫入之樣子
                { id: 'n1', t: D(Date.UTC(2020, 0, 1)) },
                { id: 'nul', t: null },
                { id: 'max9999', t: new Date('9999-12-31T23:59:59.999Z') },
            ])
            assert.strict.equal((await w1.selectByPk('s1')).t, '+275760-09-13T00:00:00.000Z')
            assert.strict.equal((await w1.selectByPk('s2')).t, '-271821-04-20T00:00:00.000Z')

            //範圍內之條件值被接受, 但正年份哨兵s1(+275760年, 時間序屬未來)因字串字典序小於'2026-…'而被$lt現在命中(此即文件所載之限制, 非本檢核可防);
            //s2(-271821年)雖亦命中, 但屬時間序之過去, 結果碰巧正確; null與範圍內最大日期(9999年底)不被命中(文件建議之永不過期寫法)
            let hit = ids(await w1.select({ t: { $lt: new Date() } }))
            assert.strict.deepStrictEqual(hit, ['n1', 's1', 's2'])

            //同理$gt最小日期之條件命不到s1(時間序應命中)
            let hit2 = ids(await w1.select({ t: { $gt: D(MS.min) } }))
            assert.strict.deepStrictEqual(hit2, ['max9999', 'n1'])

            //亦漏查未來之資料: $gt範圍內最大日期按時間序應命中s1(+275760年)卻無命中
            let hit3 = ids(await w1.select({ t: { $gt: D(MS.max) } }))
            assert.strict.deepStrictEqual(hit3, [])

            //delAll依同一判定刪除(select命中之數據即delAll刪除之數據), 文件建議之null與9999年底寫法保留
            let r = await w1.delAll({ t: { $lt: new Date() } })
            assert.strict.deepStrictEqual(r, { n: 3, nDeleted: 3, ok: 1 })
            assert.strict.deepStrictEqual(ids(await w1.select()), ['max9999', 'nul'])
            await w1.close()
        })

        //時序: 已關閉先於本檢核
        it('should reject with closed message before date range check for closed instance', async function() {
            let w1 = WOrm({ url: `${url}/daterange-closed`, db: dbName, cl: 'closed' })
            await w1.insert({ id: 'x1', t: ok() })
            await w1.close()
            let o1 = mkObserver(w1)
            for (let fn of ['select', 'delAll']) {
                let out = await o1.invoke(fn, { t: { $lt: D(MS.big) } })
                assert.strict.equal(out.ok, false)
                assert.strict.equal(out.err.message, `can not ${fn} by closed client, instance can not be used after close()`)
            }
        })

        //時序: 壞條件於佇列之外立即reject, 不等候先前已排入佇列之操作, 且不使其後之呼叫失敗
        it('should reject out-of-range Date before queued operations finish and keep queue working', async function() {
            let w1 = WOrm({ url: `${url}/daterange-queue`, db: dbName, cl: 'queue' })
            let o1 = mkObserver(w1)
            await resetDr(w1)
            let rows = []
            for (let i = 0; i < 2000; i++) {
                rows.push({ id: `q${i}`, g: 'Q', v: i })
            }
            for (let fn of ['select', 'delAll']) {
                let done = false
                let pmBig = w1.insertBulk(rows.map((v) => ({ ...v, id: `${fn}-${v.id}` }))).then(function(r) {
                    done = true
                    return r
                })
                let out = await o1.invoke(fn, { t: { $gt: D(MS.big) } }, () => done)
                chkRej(out, fn)
                assert.strict.equal(out.probe, false, `${fn} should reject before the queued insertBulk finishes`)
                let rBulk = await pmBig
                assert.strict.equal(rBulk.nInserted, 2000)
            }
            assert.strict.deepStrictEqual(ids(await w1.select({ t: { $gte: D(MS.min) } })), ['r1', 'r2', 'r3', 'r4'])
            let r = await w1.delAll({ g: 'Q' })
            assert.strict.deepStrictEqual(r, { n: 4000, nDeleted: 4000, ok: 1 })
            assert.strict.deepStrictEqual(ids(await w1.select()), ['r1', 'r2', 'r3', 'r4', 'r5'])
            await w1.close()
        })

        //時序: useCache已填入快取時仍須reject, 快取與資料不受影響; 範圍內之Date條件仍可用
        it('should reject out-of-range Date with filled cache and keep data', async function() {
            let w1 = WOrm({ url: `${url}/daterange-cache`, db: dbName, cl: 'cache', useCache: true })
            let o1 = mkObserver(w1)
            await w1.insertBulk(rowsDr())
            assert.strict.equal((await w1.select()).length, 5)
            for (let fn of ['select', 'delAll']) {
                for (let ms of [MS.belowMin, MS.aboveMax, MS.big, MS.small]) {
                    let out = await o1.invoke(fn, { t: { $gt: D(ms) } })
                    chkRej(out, fn, expectMsg('find.t.$gt'))
                }
            }
            assert.strict.deepStrictEqual(ids(await w1.select()), ['r1', 'r2', 'r3', 'r4', 'r5'])
            assert.strict.deepStrictEqual(ids(await w1.select({ t: { $gt: D(MS.min) } })), ['r1', 'r2', 'r4'])

            //熱快取下範圍內之Date條件於delAll亦照常(delAll一律直讀資料庫), 刪除後select不再命中
            assert.strict.deepStrictEqual(await w1.delAll({ t: { $gt: D(MS.min) } }), { n: 3, nDeleted: 3, ok: 1 })
            assert.strict.deepStrictEqual(ids(await w1.select()), ['r3', 'r5'])
            await w1.close()
        })

        //時序: 檢核先於讀取, 資料庫內有無法解碼之紀錄時, 範圍外Date仍須回invalid find(未讀取), 範圍內Date則因讀取而回解碼錯誤
        it('should check date range before reading the database', async function() {
            let urlBad = `${url}/daterange-unreadable`
            let raw = new Level(`${urlBad}/${dbName}/un`, { valueEncoding: 'buffer' })
            await raw.put('bad', Buffer.from('{ invalid JSON'))
            await raw.close()

            let w1 = WOrm({ url: urlBad, db: dbName, cl: 'un' })
            let o1 = mkObserver(w1)
            for (let fn of ['select', 'delAll']) {
                let outOk = await o1.invoke(fn, { t: { $lt: D(MS.max) } })
                assert.strict.equal(outOk.ok, false, `${fn} with in-range Date should reject by unreadable record`)
                assert.strict.ok(outOk.err.message.indexOf('invalid find') < 0, outOk.err.message)

                let outBad = await o1.invoke(fn, { t: { $lt: D(MS.aboveMax) } })
                chkRej(outBad, fn, expectMsg('find.t.$lt'))
            }
            await w1.close()
        })

    })

})
