import assert from 'assert'
import fs from 'fs'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'
import { mkObserver } from './lib/mkObserver.mjs'
import { proxyRevoked, proxyTagThrows, proxyOwnKeysThrows, proxyProtoThrows, arr1Getter, proxyGetThrows, proxyGetKeyThrows, objGetterThrows } from './lib/hostile.mjs'


//w-orm系列全族對齊口徑A1~A6(第557項對齊輪, 2026-11-20 oro557b2; 帳本R-ALIGN-01, 依據common-rules規則二、四):
//  A1 選項容器本身不可讀(opt或option為已撤銷之Proxy、get陷阱或Symbol.toStringTag拋錯者, 讀其成員即拋錯): 固定詞彙invalid option: must be a readable value(建構為invalid opt: ...), 走原通道(寫入入口:
//     error事件恰一次後reject、資料庫不變; 建構: 同步throw)
//  A2 存取器拋錯(容器可讀而其成員為拋錯之存取器: 建構opt.<鍵>、option.<鍵>、單元素陣列[0]、經原型讀出之id、複本內繼承之存取器): 於讀取處捕捉, 轉固定詞彙invalid <名稱>: must be a readable value, 原通道, 不轉出拋出者之文字
//  A3 複製階段之巢狀不可讀值(資料內之id、列之成員、陣列其後之元素、各欄為已撤銷之Proxy或拋錯之存取器; 於cloneDeep拋錯): 固定詞彙invalid data: must be a readable value, 走與頂層不可讀相同之通道
//     (error事件恰一次、data為null後reject、資料庫不變), 複製處之catch不分辨頂層與巢狀
//  A4 入口階段拒絕之error事件之data為null(不把不可讀之值或含其之複本交給訂閱函數); 入口階段之後之拒絕(Date範圍、主鍵、衝突)之data仍為複本(對照)
//  A5 selectByPk之不可讀pk: reject invalid pk: must be a readable value(error事件恰一次); 可讀而非字串者回null
//  A6 主鍵給了而無效(非字串): invalid id: not a string at [data[k].id], 見unit-pk-given(其badIds全集 × autoGenPk × 入口), 本檔另補與A2、A3並存之對照
describe('align-readable', function() {
    let url = './test/_tmp/align-readable'

    let opened = []
    let nCtor = 0
    let mk = (name, opt = {}) => {
        let wo = WOrm({ url: `${url}/${name}`, db: 'worm', cl: name, ...opt })
        opened.push(wo)
        return wo
    }
    let snap = async(wo) => (await wo.select()).sort((a, b) => (a.id < b.id ? -1 : 1))
    let seed = () => [{ id: 'seed1', a: 1 }]

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

    //leaks, 原例外文字(拋出者之文字): 固定詞彙不得含之(V20)
    let leaks = /boom|revoked|Cannot|call stack|primitive/i

    //rd, 固定詞彙
    let rd = (name) => `invalid ${name}: must be a readable value`

    //entries4, 4個寫入入口
    let entries4 = [
        { fn: 'insert', call: (wo, d, o) => wo.insert(d, o) },
        { fn: 'insertBulk', call: (wo, d) => wo.insertBulk(d) },
        { fn: 'save', call: (wo, d, o) => wo.save(d, o) },
        { fn: 'del', call: (wo, d) => wo.del(d) },
    ]

    //chkRej, 入口階段之拒絕: reject為本套件之Error(固定詞彙), error事件於reject之前恰一次(mode為該入口)且data為null, 不發change; 其後之佇列照常
    let chkRej = async(wo, out, fn, msg, snapBefore) => {
        assert.strict.equal(out.ok, false, `${fn} should reject, got ${JSON.stringify(out.val)}`)
        assert.strict.ok(out.err instanceof Error)
        assert.strict.equal(out.err.message, msg)
        assert.strict.ok(!leaks.test(out.err.message), 'the thrower\'s text must not be echoed')
        let evErr = out.evs.filter((v) => v.t === 'error')
        assert.strict.equal(evErr.length, 1, `${fn} should emit error exactly once`)
        assert.strict.equal(out.nAtSettle, 1, `${fn} should emit error before reject`)
        assert.strict.equal(evErr[0].settledAtEmit, false)
        assert.strict.equal(evErr[0].mode, fn)
        assert.strict.equal(evErr[0].err, msg)
        //以ok而非equal斷言null: data失敗時可能為不可讀之Proxy, equal之失敗訊息會inspect它而使mocha序列化失敗(整個執行異常結束)
        assert.strict.ok(evErr[0].data === null, 'error event data is null for an entry-stage rejection (A4)')
        assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0, 'no change event')
        assert.deepStrictEqual(await snap(wo), snapBefore, 'database unchanged')
        let r = await wo.selectByPk('seed1')
        assert.deepStrictEqual(r, { id: 'seed1', a: 1 }, 'the queue is not stuck')
    }

    //mkInst, 類別實例, id經原型上之存取器讀出
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

    //A1: 選項容器本身不可讀
    describe('A1: option container unreadable', function() {
        let containers = [
            { key: 'revoked Proxy', mk: proxyRevoked },
            { key: 'Proxy whose get trap throws for every key (incl. Symbol.toStringTag)', mk: proxyGetThrows },
        ]

        describe('insert and save: invalid option, original channel (one error event, data null, database unchanged)', function() {
            let wo = null
            let ob = null
            before(async function() {
                wo = mk('a1-option')
                ob = mkObserver(wo)
                await wo.insertBulk(seed())
            })
            for (let c of containers) {
                it(`insert: option = ${c.key}: rejects invalid option`, async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => wo.insert({ id: 'o1', a: 1 }, c.mk()))
                    await chkRej(wo, out, 'insert', rd('option'), snapBefore)
                })
                it(`save: option = ${c.key}: rejects invalid option`, async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => wo.save({ id: 'o1', a: 1 }, c.mk()))
                    await chkRej(wo, out, 'save', rd('option'), snapBefore)
                })
                it(`insert: invalid data with option = ${c.key}: the option is read first, so it is rejected as invalid option`, async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => wo.insert(null, c.mk()))
                    await chkRej(wo, out, 'insert', rd('option'), snapBefore)
                })
                it(`save: invalid data with option = ${c.key}: returns [] without reading the option (unchanged control)`, async function() {
                    let out = await ob.run(() => wo.save(null, c.mk()))
                    assert.strict.equal(out.ok, true)
                    assert.deepStrictEqual(out.val, [])
                    assert.strict.equal(out.evs.length, 0)
                })
            }

            //容器可讀(型別標籤可讀, 成員讀取不拋錯)者不受影響: 非A1
            it('control: option whose toStringTag read throws but whose members read fine works (members are read, not the tag)', async function() {
                let out = await ob.run(() => wo.insert({ id: 'ok-tag', a: 1 }, proxyTagThrows()))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(out.val, { n: 1, nInserted: 1, ok: 1 })
            })
            it('control: option whose ownKeys throws but whose members read fine works', async function() {
                let out = await ob.run(() => wo.save({ id: 'ok-ownkeys', a: 1 }, proxyOwnKeysThrows()))
                assert.strict.equal(out.ok, true)
                assert.strict.equal(out.val[0].ok, 1)
            })
        })

        describe('constructor: invalid opt, synchronous throw', function() {
            for (let c of containers) {
                it(`opt = ${c.key}: throws invalid opt: must be a readable value synchronously`, function() {
                    assert.strict.throws(() => WOrm(c.mk()), (err) => {
                        assert.strict.equal(err.message, rd('opt'))
                        assert.strict.ok(!leaks.test(err.message))
                        return true
                    })
                })
            }
        })
    })

    //A2: 存取器拋錯(容器可讀而成員之讀取拋錯)
    describe('A2: accessor throws: fixed message at the read site, the thrower\'s text is never echoed', function() {

        describe('constructor opt.<key>', function() {
            for (let key of ['url', 'db', 'cl', 'useCache', 'autoGenPk']) {
                it(`opt.${key} is a throwing own getter: throws invalid opt.${key} synchronously${key === 'url' ? '' : ', creates no folder'}`, function() {
                    let opt = { url: `${url}/ctor-${nCtor++}`, db: 'worm', cl: 'c' }
                    let u = opt.url
                    Object.defineProperty(opt, key, {
                        get() {
                            throw new Error('acc-boom')
                        },
                        enumerable: true,
                    })
                    assert.strict.throws(() => WOrm(opt), (err) => {
                        assert.strict.equal(err.message, rd(`opt.${key}`))
                        assert.strict.ok(!leaks.test(err.message))
                        return true
                    })
                    if (key !== 'url') {
                        assert.strict.equal(fs.existsSync(u), false, 'no database folder should be created')
                    }
                })
                it(`opt is a Proxy whose get trap throws only for '${key}': throws invalid opt.${key} (container readable)${key === 'url' ? '' : ', creates no folder'}`, function() {
                    let base = { url: `${url}/ctor-${nCtor++}`, db: 'worm', cl: 'c' }
                    let opt = new Proxy(base, {
                        get(t, k) {
                            if (k === key) {
                                throw new Error('get-key-boom')
                            }
                            return t[k]
                        },
                    })
                    assert.strict.throws(() => WOrm(opt), (err) => {
                        assert.strict.equal(err.message, rd(`opt.${key}`))
                        assert.strict.ok(!leaks.test(err.message))
                        return true
                    })
                    if (key !== 'url') {
                        assert.strict.equal(fs.existsSync(base.url), false, 'no database folder should be created')
                    }
                })
            }
            for (let key of ['logDetail', 'funLog']) {
                it(`control: opt.${key} is a throwing getter: handled by wsemi getDiag (diagnostic exit never fails), the constructor does not throw`, async function() {
                    let opt = { url: `${url}/ctor-${nCtor++}`, db: 'worm', cl: 'c' }
                    Object.defineProperty(opt, key, {
                        get() {
                            throw new Error('acc-boom')
                        },
                        enumerable: true,
                    })
                    let wo = WOrm(opt)
                    opened.push(wo)
                    let r = await wo.insert({ id: 'x1' })
                    assert.strict.equal(r.nInserted, 1)
                })
            }
        })

        describe('option.<key> (insert returnList, save autoInsert)', function() {
            let wo = null
            let ob = null
            before(async function() {
                wo = mk('a2-option')
                ob = mkObserver(wo)
                await wo.insertBulk(seed())
            })
            for (let [fn, key] of [['insert', 'returnList'], ['save', 'autoInsert']]) {
                for (let c of [
                    { key: 'own throwing getter', mk: objGetterThrows(key) },
                    { key: `Proxy whose get trap throws only for '${key}'`, mk: proxyGetKeyThrows(key) },
                ]) {
                    it(`${fn}: option.${key} read throws (${c.key}): rejects invalid option.${key}`, async function() {
                        let snapBefore = await snap(wo)
                        let out = await ob.run(() => wo[fn]({ id: 'o2', a: 1 }, c.mk()))
                        await chkRej(wo, out, fn, rd(`option.${key}`), snapBefore)
                    })
                }
            }
        })

        describe('one-element array data whose [0] getter throws (read by this package inside try)', function() {
            let wo = null
            let ob = null
            before(async function() {
                wo = mk('a2-elem')
                ob = mkObserver(wo)
                await wo.insertBulk(seed())
            })
            for (let e of entries4) {
                it(`${e.fn}: rejects invalid data, data null`, async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => e.call(wo, arr1Getter()))
                    await chkRej(wo, out, e.fn, rd('data'), snapBefore)
                })
            }
        })

        //複本保留原型: 類別實例原型上之存取器於複本上仍執行呼叫端之程式
        describe('accessors on the prototype of a row (the copy keeps the prototype)', function() {
            let mkIdThrows = () => mkInst(() => {
                throw new Error('id-acc-boom')
            })
            let mkInherited = () => {
                let proto = {}
                Object.defineProperty(proto, 'x', {
                    get() {
                        throw new Error('inh-acc-boom')
                    },
                    enumerable: true,
                })
                let o = Object.create(proto)
                o.id = 'i1'
                o.a = 1
                return o
            }
            let mkToJsonThrows = () => {
                class T {
                    constructor() {
                        this.id = 't1'
                        this.a = 1
                    }

                    get toJSON() {
                        throw new Error('toJSON-acc-boom')
                    }
                }
                return new T()
            }
            let w4 = ['insert', 'insertBulk', 'save', 'del']
            let w3 = ['insert', 'insertBulk', 'save']
            //2026-11-20(第569項olv569, 帳本R-PKOWN-01)起移出本表二案: 「id getter回傳已撤銷之Proxy」與「id setter拋錯(補主鍵時之指派)」——
            //原型上之id屬繼承而非自有可列舉, 視為未帶: 其回傳值不被探測(見unit-probe-readable〈id read through a prototype accessor〉), 補主鍵以defineProperty不執行setter(見unit-pk-own O9)
            let cases = [
                { key: 'id getter throws', mk: mkIdThrows, fns: w4 },
                { key: 'inherited enumerable accessor of a nested field throws (read by the well-formedness check)', mk: mkInherited, fns: w3 },
                { key: 'toJSON accessor on the prototype throws (read by the Date range walk)', mk: mkToJsonThrows, fns: w3 },
            ]
            for (let apk of [true, false]) {
                describe(`autoGenPk ${apk}`, function() {
                    let wo = null
                    let ob = null
                    before(async function() {
                        wo = mk(`a2-proto-${apk}`, { autoGenPk: apk })
                        ob = mkObserver(wo)
                        await wo.insertBulk(seed())
                    })
                    for (let c of cases) {
                        for (let fn of c.fns) {
                            it(`${fn}: ${c.key}: rejects invalid data, data null, database unchanged`, async function() {
                                let snapBefore = await snap(wo)
                                let e = entries4.find((v) => v.fn === fn)
                                let out = await ob.run(() => e.call(wo, [c.mk()]))
                                await chkRej(wo, out, fn, rd('data'), snapBefore)
                            })
                        }
                    }
                    it('save with an existing id: the inherited accessor throwing is rejected as invalid data, data null', async function() {
                        let proto = {}
                        Object.defineProperty(proto, 'x', {
                            get() {
                                throw new Error('inh-acc-boom')
                            },
                            enumerable: true,
                        })
                        let o = Object.create(proto)
                        o.id = 'seed1'
                        o.a = 2
                        let snapBefore = await snap(wo)
                        let out = await ob.run(() => wo.save([o]))
                        await chkRej(wo, out, 'save', rd('data'), snapBefore)
                    })
                })
            }

            //有狀態之繼承存取器(第N次讀取才拋錯): save對既有主鍵之處理, 複本之後之各讀取站(良構檢核、合併、合併後檢核)皆經guardRead,
            //不論存取器自第幾次讀取起拋錯, 拋出者之文字皆不外洩; 且整批與逐筆兩種通道皆出現(使合併站之guard可被鑑別)
            describe('stateful inherited accessor that starts to throw at the N-th read (save on an existing id: merge path)', function() {
                let mkStateful = (limit, counter) => {
                    let proto = {}
                    Object.defineProperty(proto, 'x', {
                        get() {
                            counter.n++
                            if (counter.n > limit) {
                                throw new Error('stateful-boom')
                            }
                            return 1
                        },
                        enumerable: true,
                    })
                    let o = Object.create(proto)
                    o.id = 'seed1'
                    o.a = 2

                    //巢狀之非純物件: 合併(merge)以參照指派, 其繼承存取器於合併後之檢核(chkOrmData(vIn))再被讀取
                    o.n = Object.create(proto)
                    return o
                }
                it('for every read index, the thrower\'s text is never leaked; both the whole-batch and the per-item channels occur with the fixed message', async function() {
                    let wo = mk('a2-stateful')
                    let ob = mkObserver(wo)
                    await wo.insertBulk(seed())
                    let c0 = { n: 0 }
                    let r0 = await ob.run(() => wo.save([mkStateful(Infinity, c0)]))
                    assert.strict.equal(r0.ok, true)
                    let nReads = c0.n
                    assert.strict.ok(nReads >= 4, `the accessor is read at the well-formedness check (2), the merge and the post-merge check (got ${nReads})`)
                    let kinds = new Set()
                    for (let lim = 0; lim < nReads; lim++) {
                        let c = { n: 0 }
                        let out = await ob.run(() => wo.save([mkStateful(lim, c)]))
                        let dump = JSON.stringify([out.ok, out.err && out.err.message, out.val, out.evs.map((v) => [v.t, v.mode, v.err])])
                        assert.strict.ok(!/stateful-boom/.test(dump), `the thrower's text leaked when the accessor starts to throw at read ${lim}: ${dump}`)
                        if (out.ok === false) {
                            assert.strict.equal(out.err.message, rd('data'))
                            kinds.add('batch')
                        }
                        else if (out.val[0].ok === 0) {
                            assert.strict.equal(out.val[0].err, rd('data'))
                            kinds.add('item')
                        }
                    }
                    assert.strict.ok(kinds.has('batch'), 'the whole-batch channel (well-formedness check) occurred')
                    assert.strict.ok(kinds.has('item'), 'the per-item channel (merge path) occurred')
                })
            })
        })
    })

    //A3: 複製階段之巢狀不可讀值
    describe('A3: nested unreadable value met at the copy stage: invalid data (no distinction between top level and nested), data null, database unchanged', function() {
        let accNest = () => {
            let o = { a: 1 }
            Object.defineProperty(o, 'x', {
                get() {
                    throw new Error('acc-boom')
                },
                enumerable: true,
            })
            return o
        }
        let deepObj = (n) => {
            let o = {}
            let cur = o
            for (let i = 0; i < n; i++) {
                cur.n = {}
                cur = cur.n
            }
            return o
        }
        let nullProtoDate = () => {
            let d = new Date(0)
            Object.setPrototypeOf(d, null)
            return { id: 'a1', t: d }
        }
        let nested = [
            { key: 'row is a revoked Proxy (array [ok, revoked])', mk: () => [{ id: 'a1' }, proxyRevoked()] },
            { key: 'row is a revoked Proxy (array [ok, ok, revoked]: element after the first)', mk: () => [{ id: 'a1' }, { id: 'a2' }, proxyRevoked()] },
            { key: 'row is a revoked Proxy (array [revoked, ok])', mk: () => [proxyRevoked(), { id: 'a1' }] },
            { key: 'row whose toStringTag read throws', mk: () => [{ id: 'a1' }, proxyTagThrows()] },
            { key: 'row whose ownKeys throws', mk: () => [{ id: 'a1' }, proxyOwnKeysThrows()] },
            { key: 'own id is a revoked Proxy', mk: () => ({ id: proxyRevoked(), a: 1 }) },
            { key: 'own id whose toStringTag read throws', mk: () => ({ id: proxyTagThrows(), a: 1 }) },
            { key: 'own id is a throwing getter', mk: objGetterThrows('id') },
            { key: 'field is a revoked Proxy (u8a-like)', mk: () => ({ id: 'a1', u8a: proxyRevoked() }) },
            { key: 'field whose toStringTag read throws', mk: () => ({ id: 'a1', f: proxyTagThrows() }) },
            { key: 'field whose ownKeys throws', mk: () => ({ id: 'a1', f: proxyOwnKeysThrows() }) },
            { key: 'field whose getPrototypeOf throws', mk: () => ({ id: 'a1', f: proxyProtoThrows() }) },
            { key: 'field is an object with a throwing getter', mk: () => ({ id: 'a1', o: accNest() }) },
            { key: 'deeply nested field is a revoked Proxy', mk: () => ({ id: 'a1', o: { p: { q: proxyRevoked() } } }) },
            { key: 'second row has a revoked Proxy field (the first row is valid: no partial write)', mk: () => [{ id: 'a1' }, { id: 'a2', f: proxyRevoked() }] },
            { key: 'null-prototype Date (copy throws)', mk: nullProtoDate },
            { key: 'nesting deep enough to overflow the stack', mk: () => ({ id: 'a1', o: deepObj(50000) }) },
        ]
        for (let apk of [true, false]) {
            describe(`autoGenPk ${apk}`, function() {
                let wo = null
                let ob = null
                before(async function() {
                    wo = mk(`a3-${apk}`, { autoGenPk: apk })
                    ob = mkObserver(wo)
                    await wo.insertBulk(seed())
                })
                for (let c of nested) {
                    for (let e of entries4) {
                        it(`${e.fn}: ${c.key}`, async function() {
                            let snapBefore = await snap(wo)
                            let out = await ob.run(() => e.call(wo, c.mk()))
                            await chkRej(wo, out, e.fn, rd('data'), snapBefore)
                        })
                    }
                }
            })
        }
    })

    //A4: error事件之data
    describe('A4: error event data', function() {
        let wo = null
        let ob = null
        before(async function() {
            wo = mk('a4')
            ob = mkObserver(wo)
            await wo.insertBulk(seed())
        })

        it('entry-stage rejections (option, data container, copy stage) pass null (covered by every chkRej above): spot check of the three stages', async function() {
            for (let [fn, call] of [
                ['insert', () => wo.insert({ id: 'e1' }, proxyRevoked())],
                ['insertBulk', () => wo.insertBulk(proxyRevoked())],
                ['del', () => wo.del([{ id: 'seed1' }, proxyRevoked()])],
            ]) {
                let out = await ob.run(call)
                assert.strict.equal(out.ok, false)
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1, fn)
                assert.strict.ok(evErr[0].data === null, fn)

                //del之第1列為既存之seed1: 複製階段失敗時不得已刪除該列(無部分刪除)
                assert.deepStrictEqual(await wo.selectByPk('seed1'), { id: 'seed1', a: 1 }, `${fn}: no partial write or delete`)
            }
        })

        //入口階段之後之拒絕(資料可讀, 已有複本)之data仍為複本(對照, 不得被一併改為null)
        let post = [
            { key: 'Date out of range', fn: 'insert', mk: () => [{ id: 'd1', t: new Date(8.64e15) }], opt: {} },
            { key: 'id given but not a string', fn: 'insert', mk: () => [{ id: 5, a: 1 }], opt: {} },
            { key: 'id not given with autoGenPk false', fn: 'insert', mk: () => [{ a: 1 }], opt: { autoGenPk: false } },
            { key: 'existed id for insertBulk', fn: 'insertBulk', mk: () => [{ id: 'seed1', a: 9 }], opt: {} },
        ]
        for (let c of post) {
            it(`${c.key}: rejects after the copy exists: error event data is a copy of the input (not null, not the same object)`, async function() {
                let w2 = mk(`a4-post-${c.key.replace(/\W+/g, '_')}`, c.opt)
                let ob2 = mkObserver(w2)
                await w2.insertBulk(seed())
                let d = c.mk()
                let out = await ob2.run(() => w2[c.fn](d))
                assert.strict.equal(out.ok, false)
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1)
                assert.strict.ok(evErr[0].data !== null && evErr[0].data !== d)
                assert.deepStrictEqual(evErr[0].data, d)
            })
        }

        //已關閉之實例: 先於讀取即拒絕, data為呼叫端傳入之原值, 惟型別標籤不可讀者為null
        describe('closed instance: the caller\'s value is passed as is when readable, null when unreadable', function() {
            for (let e of entries4) {
                it(`${e.fn}: closed + readable data: the same object; closed + revoked Proxy: null`, async function() {
                    let w3 = mk(`a4-closed-${e.fn}`)
                    let ob3 = mkObserver(w3)
                    await w3.insertBulk(seed())
                    await w3.close()
                    let d = [{ id: 'k1' }]
                    let out = await ob3.run(() => e.call(w3, d))
                    assert.strict.equal(out.ok, false)
                    assert.strict.ok(/closed/.test(out.err.message))
                    let evErr = out.evs.filter((v) => v.t === 'error')
                    assert.strict.equal(evErr.length, 1)
                    assert.strict.ok(evErr[0].data === d, 'readable data is passed as is')
                    let out2 = await ob3.run(() => e.call(w3, proxyRevoked()))
                    assert.strict.equal(out2.ok, false)
                    assert.strict.ok(/closed/.test(out2.err.message))
                    let evErr2 = out2.evs.filter((v) => v.t === 'error')
                    assert.strict.equal(evErr2.length, 1)
                    assert.strict.ok(evErr2[0].data === null, 'an unreadable value is not handed to subscribers')
                })
            }
        })
    })

    //A5: selectByPk之不可讀pk
    describe('A5: selectByPk with an unreadable pk rejects, a readable non-string resolves null', function() {
        let wo = null
        let ob = null
        before(async function() {
            wo = mk('a5')
            ob = mkObserver(wo)
            await wo.insertBulk(seed())
        })
        for (let c of [
            { key: 'revoked Proxy', mk: proxyRevoked },
            { key: 'toStringTag read throws', mk: proxyTagThrows },
            { key: 'get trap throws for every key', mk: proxyGetThrows },
        ]) {
            it(`pk = ${c.key}: rejects invalid pk, one error event before reject (data null), no change`, async function() {
                let out = await ob.run(() => wo.selectByPk(c.mk()))
                assert.strict.equal(out.ok, false)
                assert.strict.equal(out.err.message, rd('pk'))
                assert.strict.ok(!leaks.test(out.err.message))
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1)
                assert.strict.equal(out.nAtSettle, 1)
                assert.strict.equal(evErr[0].settledAtEmit, false)
                assert.strict.equal(evErr[0].mode, 'selectByPk')
                assert.strict.ok(evErr[0].data === null, 'selectByPk error event data is null')
                assert.strict.equal(evErr[0].err, rd('pk'))
                assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0)
                assert.deepStrictEqual(await wo.selectByPk('seed1'), { id: 'seed1', a: 1 })
            })
        }
        for (let c of [
            { key: 'number 5', mk: () => 5 },
            { key: 'String wrapper', mk: () => new String('seed1') }, // eslint-disable-line no-new-wrappers
            { key: 'undefined', mk: () => undefined },
            { key: 'null', mk: () => null },
            { key: 'empty string', mk: () => '' },
            { key: 'Symbol', mk: () => Symbol('s') },
            { key: 'BigInt', mk: () => 1n },
            { key: 'function', mk: () => () => 1 },
            { key: 'plain object', mk: () => ({}) },
            { key: 'Proxy whose ownKeys throws (tag readable)', mk: proxyOwnKeysThrows },
        ]) {
            it(`pk = ${c.key} (readable, not a string): resolves null, no events`, async function() {
                let out = await ob.run(() => wo.selectByPk(c.mk()))
                assert.strict.equal(out.ok, true)
                assert.strict.equal(out.val, null)
                assert.strict.equal(out.evs.length, 0)
            })
        }
    })

    //A6: 主鍵給了而無效, 與可讀性並存時之優先序(對照; 全集見unit-pk-given)
    describe('A6: a given non-string id is rejected as not a string, never replaced (pinned in unit-pk-given); readable-value rejections do not turn it into a generated id', function() {
        for (let apk of [true, false]) {
            it(`autoGenPk ${apk}: id 5 is rejected as not a string and nothing is written; an id that is a revoked Proxy is rejected as invalid data (A3), nothing is written`, async function() {
                let wo = mk(`a6-${apk}`, { autoGenPk: apk })
                let ob = mkObserver(wo)
                await wo.insertBulk(seed())
                let out = await ob.run(() => wo.insert([{ id: 5, a: 1 }]))
                assert.strict.equal(out.ok, false)
                assert.strict.equal(out.err.message, 'invalid id: not a string at [data[0].id]')
                let out2 = await ob.run(() => wo.insert([{ id: proxyRevoked(), a: 1 }]))
                assert.strict.equal(out2.ok, false)
                assert.strict.equal(out2.err.message, rd('data'))
                assert.deepStrictEqual(await snap(wo), [{ id: 'seed1', a: 1 }])
            })
        }
    })

    //del之原型存取器id回不可讀之值: 為該筆ok:0之not a string(del既有之逐筆通道, chkPk對非字串一律如此; 與insert、insertBulk、save之整批invalid data不同, 帳本R-ALIGN-01已知邊界③), 釘住現況
    describe('A6/boundary: del with a prototype accessor id returning an unreadable value is a per-item not-a-string failure (pinned current channel)', function() {
        for (let apk of [true, false]) {
            it(`autoGenPk ${apk}: that item gives ok 0 with the fixed not-a-string message, nothing is deleted`, async function() {
                let wo = mk(`a6-del-${apk}`, { autoGenPk: apk })
                let ob = mkObserver(wo)
                await wo.insertBulk(seed())
                let out = await ob.run(() => wo.del([mkInst(proxyRevoked)]))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(out.val, [{ n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' }])
                assert.deepStrictEqual(await snap(wo), [{ id: 'seed1', a: 1 }])
            })
        }
    })

    //src不得殘留原錯誤之交出路徑: 複製與讀取站點皆經固定詞彙之包裝(原始碼鎖定, 行為由上列案例驗證)
    describe('source: the copy and read sites go through the fixed-message wrappers', function() {
        let code = fs.readFileSync('./src/WOrmLevel.mjs', 'utf8').split('\n').filter((ln) => !/^\s*\/\//.test(ln)).join('\n')
        it('cloneDeep is called directly only inside copyData and the 2 useCache copies; get(opt/option, ...) only inside getOptVal and getOpt; the post-copy reads are wrapped by guardRead', function() {
            assert.strict.equal((code.match(/\bcloneDeep\(/g) || []).length, 3, 'copyData + the 2 useCache copies in getData')
            assert.strict.equal((code.match(/\bguardRead\(/g) || []).length, 10, 'chkDataDate 3 + procWellFormed 2 + save msgs 1 + save merge 1 + save merge-path chkOrmData 1 + del id reads 2 (the definition is not a call)')
            assert.strict.equal((code.match(/\bdata = cloneDeep\(/g) || []).length, 0, 'no direct cloneDeep(data) at the write entries')
            assert.strict.equal((code.match(/\bdata = copyData\(data\)/g) || []).length, 4, 'the 4 write entries copy through copyData')
            assert.strict.equal((code.match(/\bget\(opt,/g) || []).length, 1, 'get(opt, ...) once (getOptVal)')
            assert.strict.equal((code.match(/\bget\(option,/g) || []).length, 1, 'get(option, ...) once (getOpt)')
            assert.strict.equal((code.match(/\bgetOptVal\('/g) || []).length, 5)
            assert.strict.equal((code.match(/\bgetOpt\(option, '/g) || []).length, 2)
        })
    })
})
