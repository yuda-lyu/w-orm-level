import assert from 'assert'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'
import { mkObserver } from './lib/mkObserver.mjs'
import { proxyRevoked, proxyTagThrows, proxyOwnKeysThrows } from './lib/hostile.mjs'


//主鍵(id)之「未帶」與「給了而非字串」之判定(帳本R-PKGIVEN-01; 全族一致之共同規則一, wsemi 1.9.69起isestr不收String包裝物件而使原procPk之判定改變):
//  S1 未帶主鍵只有三種: id為undefined、null、''(含鍵不存在): autoGenPk為true自動產生, 為false整批reject(save亦然, 不降為逐筆), 訊息can not <fn> by data[k] without valid id when autoGenPk is false
//  S2 給了而非字串(數字、布林、物件、陣列、String包裝物件、Symbol、BigInt等)一律拒絕, 訊息invalid id: not a string at [data[k].id](固定詞彙, 不回顯值), 不得靜默換成新產生之主鍵寫入
//  S3 失敗通道依各入口既有之通道且不隨autoGenPk改變: insert與insertBulk整批reject(error事件於reject前恰一次、不發change、資料庫不變), save該筆ok為0附err, del該筆ok為0附err(既有), selectByPk回null(既有)
//  S4 讀取即拋錯之id「值」(已撤銷之Proxy等)於資料複製階段(cloneDeep)即拋錯, 轉固定詞彙invalid data: must be a readable value(w-orm系列對齊口徑A3, 帳本R-PROBE-01; 2026-11-20 oro557b2由原錯誤改固定詞彙, 不補值), error事件之data為null(A4);
//     經類別實例原型上之存取器讀出者, 見unit-probe-readable與unit-align-readable
describe('pk given', function() {
    let url = './test/_tmp/pk-given'

    //opened與mk: 於測試資料夾下建立資料庫, after統一關閉
    let opened = []
    let mk = (name, opt = {}) => {
        let wo = WOrm({ url: `${url}/${name}`, db: 'worm', cl: name, ...opt })
        opened.push(wo)
        return wo
    }

    //reUuid, genIDSeq產生之主鍵
    let reUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    //ids, 資料庫內全部主鍵(升冪; 套件產生者以<gen>表示)
    let ids = async(wo) => {
        let rs = await wo.select()
        return rs.map((v) => (reUuid.test(v.id) ? '<gen>' : v.id)).sort()
    }

    //seed, 每案前之基準資料
    let reset = async(wo) => {
        await wo.delAll()
        await wo.insertBulk([{ id: 'seed1', a: 1 }])
    }

    before(function() {
        w.fsDeleteFolder(url)
    })

    after(async function() {
        for (let wo of opened) {
            try {
                await wo.close()
            }
            catch (err) {
                //已關閉者略過
            }
        }
        w.fsDeleteFolder(url)
    })

    //badIds, 給了而非字串之id(S2)與其不得被回顯之標記; 以工廠函數取值使每案皆為全新值
    let badIds = [
        { key: 'number 5', mk: () => 5 },
        { key: 'number 0', mk: () => 0 },
        { key: 'NaN', mk: () => NaN },
        { key: 'boolean true', mk: () => true },
        { key: 'boolean false', mk: () => false },
        { key: 'plain object', mk: () => ({ a: 'SECRET-OBJ' }), secret: 'SECRET-OBJ' },
        { key: 'object with toString', mk: () => ({ toString: () => 'SECRET-TS' }), secret: 'SECRET-TS' },
        { key: 'array', mk: () => ['SECRET-ARR'], secret: 'SECRET-ARR' },
        { key: 'empty array', mk: () => [] },
        { key: 'String wrapper', mk: () => new String('SECRET-STR'), secret: 'SECRET-STR' }, // eslint-disable-line no-new-wrappers
        { key: 'Number wrapper', mk: () => new Number(5) }, // eslint-disable-line no-new-wrappers
        { key: 'Boolean wrapper', mk: () => new Boolean(true) }, // eslint-disable-line no-new-wrappers
        { key: 'Symbol', mk: () => Symbol('SECRET-SYM'), secret: 'SECRET-SYM' },
        { key: 'BigInt', mk: () => 10n },
        { key: 'function', mk: () => () => 'f' },
        { key: 'Date', mk: () => new Date(0) },
    ]

    //notGiven, 未帶id(S1)之三種(含鍵不存在)與空字串
    let notGiven = [
        { key: 'key absent', mk: () => ({ a: 1 }) },
        { key: 'undefined', mk: () => ({ id: undefined, a: 1 }) },
        { key: 'null', mk: () => ({ id: null, a: 1 }) },
        { key: 'empty string', mk: () => ({ id: '', a: 1 }) },
    ]

    //chkRejBatch, 整批性錯誤: reject之訊息、error事件恰一次且先於reject、不發change、資料庫不變
    let chkRejBatch = async(wo, out, fn, msg, secret) => {
        assert.strict.equal(out.ok, false, `${fn} should reject, got ${JSON.stringify(out.val)}`)
        assert.strict.equal(out.err.message, msg)
        let evErr = out.evs.filter((v) => v.t === 'error')
        assert.strict.equal(evErr.length, 1, `${fn} should emit error exactly once`)
        assert.strict.equal(out.nAtSettle, 1, `${fn} should emit error before reject`)
        assert.strict.equal(evErr[0].settledAtEmit, false)
        assert.strict.equal(evErr[0].mode, fn)
        assert.strict.equal(evErr[0].err, msg)
        assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0, 'no change event')
        assert.deepStrictEqual(await ids(wo), ['seed1'], 'database unchanged (no record written, never replaced by a generated id)')
        if (secret) {
            assert.strict.ok(!out.err.message.includes(secret) && !String(evErr[0].err).includes(secret), 'the value must not be echoed')
        }
    }

    for (let apk of [true, false]) {

        //S2、S3: 給了而非字串之id, 於autoGenPk為true與false下同為拒絕(通道不隨autoGenPk改變)
        describe(`given non-string id is rejected, never replaced (autoGenPk: ${apk})`, function() {
            let wo = null
            let ob = null
            let msg = 'invalid id: not a string at [data[0].id]'
            before(function() {
                wo = mk(`bad-${apk}`, { autoGenPk: apk })
                ob = mkObserver(wo)
            })
            beforeEach(async function() {
                await reset(wo)
            })

            for (let c of badIds) {

                //insert、insertBulk: 整批reject
                for (let v of [
                    { fn: 'insert', call: (id) => wo.insert([{ id, a: 1 }]), nm: 'array' },
                    { fn: 'insert', call: (id) => wo.insert({ id, a: 1 }), nm: 'single object' },
                    { fn: 'insert', call: (id) => wo.insert([{ id, a: 1 }], { returnList: true }), nm: 'returnList true' },
                    { fn: 'insertBulk', call: (id) => wo.insertBulk([{ id, a: 1 }]), nm: 'array' },
                    { fn: 'insertBulk', call: (id) => wo.insertBulk({ id, a: 1 }), nm: 'single object' },
                ]) {
                    it(`${v.fn} (${v.nm}): ${c.key} rejects the whole batch with the fixed message [S2, S3]`, async function() {
                        let out = await ob.run(() => v.call(c.mk()))
                        await chkRejBatch(wo, out, v.fn, msg, c.secret)
                    })
                }

                //save: 該筆ok為0附err(逐筆通道, 不隨autoGenPk改為整批reject)
                for (let opt of [undefined, { autoInsert: false }]) {
                    it(`save${opt ? '(autoInsert false)' : ''}: ${c.key} gives ok 0 with the fixed message for that item, nothing written [S2, S3]`, async function() {
                        let out = await ob.run(() => wo.save([{ id: c.mk(), a: 1 }], opt))
                        assert.strict.equal(out.ok, true, 'save does not reject for a per-item failure')
                        assert.deepStrictEqual(out.val, [{ n: 1, nInserted: 0, nModified: 0, ok: 0, err: msg }])
                        let evErr = out.evs.filter((v) => v.t === 'error')
                        assert.strict.equal(evErr.length, 1)
                        assert.strict.equal(evErr[0].mode, 'save')
                        assert.strict.equal(evErr[0].err, msg)
                        assert.strict.equal(out.evs.filter((v) => v.t === 'change' && v.mode === 'insert').length, 0, 'no insert event')
                        assert.deepStrictEqual(out.evs.filter((v) => v.t === 'change').map((v) => v.mode), ['save'], 'a per-item failure still ends with the one save change event (existing)')
                        assert.deepStrictEqual(await ids(wo), ['seed1'])
                        if (c.secret) {
                            assert.strict.ok(!JSON.stringify(out.val).includes(c.secret) && !String(evErr[0].err).includes(c.secret), 'the value must not be echoed')
                        }
                    })
                }

                //del: 既有之逐筆拒絕(核實不改)
                it(`del: ${c.key} gives ok 0 with the fixed message for that item (unchanged), nothing deleted [S3]`, async function() {
                    let out = await ob.run(() => wo.del([{ id: c.mk() }]))
                    assert.strict.equal(out.ok, true)
                    assert.deepStrictEqual(out.val, [{ n: 0, nDeleted: 0, ok: 0, err: msg }])
                    assert.deepStrictEqual(await ids(wo), ['seed1'])
                })

                //selectByPk: 既有之查無通道(核實不改)
                it(`selectByPk: ${c.key} resolves null, no events (unchanged) [S3]`, async function() {
                    let out = await ob.run(() => wo.selectByPk(c.mk()))
                    assert.strict.equal(out.ok, true)
                    assert.strict.equal(out.val, null)
                    assert.strict.equal(out.evs.length, 0)
                })

            }

            //批內索引: 前後筆合格而第2筆(索引1)給了非字串, 整批不寫入; save僅該筆失敗
            it('insert and insertBulk: a non-string id at index 1 rejects the whole batch at data[1], no partial write [S2, S3]', async function() {
                for (let fn of ['insert', 'insertBulk']) {
                    let out = await ob.run(() => wo[fn]([{ id: 'k1', a: 1 }, { id: 5, a: 2 }, { id: 'k3', a: 3 }]))
                    await chkRejBatch(wo, out, fn, 'invalid id: not a string at [data[1].id]')
                }
            })
            it('save: a non-string id at index 1 fails only that item; the others are saved [S3]', async function() {
                let out = await ob.run(() => wo.save([{ id: 'k1', a: 1 }, { id: 5, a: 2 }, { id: 'k3', a: 3 }]))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(out.val.map((v) => [v.ok, v.err]), [[1, undefined], [0, 'invalid id: not a string at [data[1].id]'], [1, undefined]])
                assert.deepStrictEqual(await ids(wo), ['k1', 'k3', 'seed1'])
            })

            //邊界: 非字串之id同時為範圍外Date者, R-DATE-01之Date範圍檢核先於良構檢核(既有優先序), 整批reject(含save), 訊息為Date之路徑
            it('boundary: a non-string id that is an out-of-range Date is rejected by the Date range check first (whole batch, also for save), nothing written', async function() {
                for (let fn of ['insert', 'insertBulk', 'save']) {
                    let out = await ob.run(() => wo[fn]([{ id: new Date(8.64e15), a: 1 }]))
                    await chkRejBatch(wo, out, fn, 'invalid data: Date year is out of range 0000-9999 at [data[0].id]')
                }
            })

            //對照: 良構字串主鍵與其他欄位為數字者不受影響
            it('control: a string id is kept as is, other numeric fields are untouched', async function() {
                let out = await ob.run(() => wo.insert({ id: 'ok1', n: 5, flag: true }))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(await wo.selectByPk('ok1'), { id: 'ok1', n: 5, flag: true })
            })
        })

    }

    //S1: 未帶id(三種與空字串)
    describe('not given id (undefined, null, empty string, key absent) [S1]', function() {

        describe('autoGenPk true: a primary key is generated, the caller input is not changed', function() {
            let wo = null
            let ob = null
            before(function() {
                wo = mk('gen-true')
                ob = mkObserver(wo)
            })
            beforeEach(async function() {
                await reset(wo)
            })
            for (let c of notGiven) {
                for (let fn of ['insert', 'insertBulk', 'save']) {
                    it(`${fn}: ${c.key} is written with a generated string id`, async function() {
                        let d = [c.mk()]
                        let out = await ob.run(() => wo[fn](d))
                        assert.strict.equal(out.ok, true)
                        assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0)
                        assert.deepStrictEqual(await ids(wo), ['<gen>', 'seed1'])
                        let rs = await wo.select()
                        let row = rs.find((v) => v.id !== 'seed1')
                        assert.strict.ok(typeof row.id === 'string' && reUuid.test(row.id), 'generated id is a string')
                        assert.strict.equal(row.a, 1)
                        assert.deepStrictEqual(d, [c.mk()], 'the caller input is not changed (no id written back)')
                    })
                }
            }
        })

        describe('autoGenPk false: whole batch reject for insert, insertBulk and save (save is not lowered to per-item), del and selectByPk keep their channels', function() {
            let wo = null
            let ob = null
            before(function() {
                wo = mk('gen-false', { autoGenPk: false })
                ob = mkObserver(wo)
            })
            beforeEach(async function() {
                await reset(wo)
            })
            for (let c of notGiven) {
                for (let fn of ['insert', 'insertBulk', 'save']) {
                    it(`${fn}: ${c.key} rejects the whole batch`, async function() {
                        let out = await ob.run(() => wo[fn]([c.mk()]))
                        await chkRejBatch(wo, out, fn, `can not ${fn} by data[0] without valid id when autoGenPk is false`)
                    })
                }
            }
            it('valid string ids still write', async function() {
                let out = await ob.run(() => wo.insert([{ id: 'f1' }, { id: 'f2' }]))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(await ids(wo), ['f1', 'f2', 'seed1'])
            })

            //已知邊界: 同批同時有給了而非字串(索引0)與未帶(索引1)者, procPk先報未帶(先於其後之良構檢核), 皆整批reject而不寫入
            it('boundary: a given non-string id (index 0) and a missing id (index 1) in one batch: the missing id is reported first, the whole batch rejects, nothing written', async function() {
                for (let fn of ['insert', 'insertBulk', 'save']) {
                    let out = await ob.run(() => wo[fn]([{ id: 5, a: 1 }, { a: 2 }]))
                    await chkRejBatch(wo, out, fn, `can not ${fn} by data[1] without valid id when autoGenPk is false`)
                }
            })
        })

        //del與selectByPk之未帶id: 不隨autoGenPk改變(既有通道)
        for (let apk of [true, false]) {
            describe(`del and selectByPk with no id (autoGenPk ${apk}, unchanged)`, function() {
                let wo = null
                let ob = null
                before(function() {
                    wo = mk(`nogiven-${apk}`, { autoGenPk: apk })
                    ob = mkObserver(wo)
                })
                beforeEach(async function() {
                    await reset(wo)
                })
                for (let c of notGiven) {
                    it(`del: ${c.key} gives ok 0 for that item, nothing deleted, nothing generated`, async function() {
                        let out = await ob.run(() => wo.del([c.mk()]))
                        assert.strict.equal(out.ok, true)
                        assert.strict.equal(out.val[0].ok, 0)
                        assert.strict.equal(out.val[0].err, c.key === 'empty string' ? 'invalid id: string is empty at [data[0].id]' : 'invalid id: not a string at [data[0].id]')
                        assert.deepStrictEqual(await ids(wo), ['seed1'])
                    })
                }
                for (let v of [undefined, null, '']) {
                    it(`selectByPk(${JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v)}) resolves null, no events`, async function() {
                        let out = await ob.run(() => wo.selectByPk(v))
                        assert.strict.equal(out.ok, true)
                        assert.strict.equal(out.val, null)
                        assert.strict.equal(out.evs.length, 0)
                    })
                }
            })
        }
    })

    //S4: 讀取即拋錯之id值(自有屬性): 資料複製階段即拋錯, 轉固定詞彙invalid data: must be a readable value(A3; 不含原例外文字, 不被補值亦不被換成新id), error事件之data為null(A4); 經原型存取器讀出者見unit-probe-readable
    describe('unreadable id value as an own property: rejected at the copy stage with the fixed message, never replaced [S4, A3]', function() {
        let kinds = [
            { key: 'revoked Proxy', mk: proxyRevoked, msg: /revoked/i },
            { key: 'Proxy whose toStringTag read throws', mk: proxyTagThrows, msg: /tag-boom/ },
            { key: 'Proxy whose ownKeys throws', mk: proxyOwnKeysThrows, msg: /ownKeys-boom/ },
        ]
        for (let apk of [true, false]) {
            describe(`autoGenPk ${apk}`, function() {
                let wo = null
                let ob = null
                before(function() {
                    wo = mk(`own-${apk}`, { autoGenPk: apk })
                    ob = mkObserver(wo)
                })
                beforeEach(async function() {
                    await reset(wo)
                })
                for (let k of kinds) {
                    for (let fn of ['insert', 'insertBulk', 'save', 'del']) {
                        it(`${fn}: ${k.key} rejects with the fixed message (not the original error), one error event with data null, database unchanged [A3, A4]`, async function() {
                            let out = await ob.run(() => wo[fn]([{ id: k.mk(), a: 1 }]))
                            assert.strict.equal(out.ok, false)
                            assert.strict.equal(out.err.message, 'invalid data: must be a readable value')
                            assert.strict.ok(!k.msg.test(out.err.message), 'the original exception text must not be echoed')
                            let evErr = out.evs.filter((v) => v.t === 'error')
                            assert.strict.equal(evErr.length, 1)
                            assert.strict.ok(evErr[0].data === null, 'error event data is null for an entry-stage rejection')
                            assert.strict.equal(evErr[0].err, 'invalid data: must be a readable value')
                            assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0)
                            assert.deepStrictEqual(await ids(wo), ['seed1'])
                        })
                    }
                }
            })
        }
    })

    //經類別實例原型上之存取器讀出之id(複本保留原型, 存取器於複本上仍執行呼叫端之程式): 屬繼承而非自有可列舉之id, 視為「未帶」(帳本R-PKOWN-01, 2026-11-20 olv569起),
    //回傳之值(字串、數字、包裝物件、不可讀者)不被使用: autoGenPk為true補新主鍵(不以存取器回傳之字串為鍵), 為false依「未帶」整批reject;
    //2026-11-20前此處為「回傳字串者以該字串為鍵(值不含id欄位)、可讀而非字串者拒絕為not a string」, 即第569項之缺陷(主鍵遺失/與同值既有列衝突)
    describe('id read through a prototype accessor: an inherited id is not a given id, whatever the accessor returns (R-PKOWN-01)', function() {
        let mkInst = (mkId) => {
            class P {
                constructor() {
                    this.a = 1
                }

                get id() {
                    return mkId()
                }
            }
            return new P()
        }
        for (let apk of [true, false]) {
            describe(`autoGenPk ${apk}`, function() {
                let wo = null
                let ob = null
                before(function() {
                    wo = mk(`proto-${apk}`, { autoGenPk: apk })
                    ob = mkObserver(wo)
                })
                beforeEach(async function() {
                    await reset(wo)
                })
                for (let v of [
                    { key: 'number 5', mk: () => 5 },
                    { key: 'String wrapper', mk: () => new String('a') }, // eslint-disable-line no-new-wrappers
                    { key: 'Proxy whose ownKeys throws (tag readable)', mk: proxyOwnKeysThrows },
                    { key: 'a string', mk: () => 'acc1' },
                ]) {
                    for (let fn of ['insert', 'insertBulk', 'save']) {
                        if (apk) {
                            it(`${fn}: accessor returns ${v.key}: not a given id, a generated id is stored (the accessor's value is not the key)`, async function() {
                                let out = await ob.run(() => wo[fn](mkInst(v.mk)))
                                assert.strict.equal(out.ok, true, `${fn} should resolve, got ${out.err && out.err.message}`)
                                if (fn === 'save') {
                                    assert.deepStrictEqual(out.val, [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }])
                                }
                                else {
                                    assert.deepStrictEqual(out.val, { n: 1, nInserted: 1, ok: 1 })
                                }
                                assert.deepStrictEqual(await ids(wo), ['<gen>', 'seed1'])
                                assert.strict.equal(await wo.selectByPk('acc1'), null)
                                assert.strict.equal(out.evs.filter((x) => x.t === 'error').length, 0)
                            })
                        }
                        else {
                            it(`${fn}: accessor returns ${v.key}: not a given id, rejected as not given (whole batch, even for save)`, async function() {
                                let out = await ob.run(() => wo[fn](mkInst(v.mk)))
                                await chkRejBatch(wo, out, fn, `can not ${fn} by data[0] without valid id when autoGenPk is false`)
                            })
                        }
                    }
                }
                it('insert: accessor that itself throws: the fixed message (the thrower\'s text is not echoed), one error event with data null, database unchanged [A2, A4]', async function() {
                    let out = await ob.run(() => wo.insert(mkInst(() => {
                        throw new Error('accessor-boom')
                    })))
                    assert.strict.equal(out.ok, false)
                    assert.strict.equal(out.err.message, 'invalid data: must be a readable value')
                    let evErr = out.evs.filter((v) => v.t === 'error')
                    assert.strict.equal(evErr.length, 1)
                    assert.strict.ok(evErr[0].data === null, 'error event data is null')
                    assert.deepStrictEqual(await ids(wo), ['seed1'])
                })
            })
        }
    })
})
