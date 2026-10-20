import assert from 'assert'
import w from 'wsemi'
import { Level } from 'level'
import WOrm from '../src/WOrmLevel.mjs'
import { mkObserver } from './lib/mkObserver.mjs'


//寫入入口之前置處理與錯誤路徑(帳本R-WRITE-ERR-01, 排程第80項; 來源為第77項外審Argon F-03(a))
//寫入入口insert、insertBulk、save、del於try之外原有讀取呼叫端輸入之前置處理(讀option、iseobj/isearr判定、cloneDeep(data)),
//其拋錯者(原型為null或constructor為null之Date、存取器拋錯、Proxy trap拋錯、深度過大之stack overflow等)修前reject但不發error事件,
//規則: 任何因輸入導致之失敗皆走同一錯誤路徑, 即「error事件恰一次且先於reject, 不發change, 資料庫不變, 訊息不回顯值」
describe('write-pre-error', function() {
    let url = './test/_tmp/write-pre-error'

    //MARK, 放進紀錄內之標記字串, 錯誤訊息不得回顯資料值(帳本規則2)
    let MARK = 'SECRET-MARK-9f3a'

    //壞輸入之建構器: 皆使lodash cloneDeep或其前之iseobj/isearr同步拋錯
    let nullProtoDate = () => {
        let d = new Date(0)
        Object.setPrototypeOf(d, null)
        return d
    }
    let nullCtorDate = () => {
        let d = new Date(0)
        Object.defineProperty(d, 'constructor', { value: null })
        return d
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

    //throwingGetter, 讀取欄位x時拋出v(v可為任意型別之值)
    let throwingGetter = (v) => {
        return {
            get x() {
                throw v
            },
        }
    }
    let arr1Getter = () => {
        let a = [0]
        Object.defineProperty(a, '0', {
            get() {
                throw new Error('elem-getter-boom')
            },
            enumerable: true,
        })
        return a
    }
    let proxyOwnKeysThrows = () => {
        return new Proxy({ id: 'z1' }, {
            ownKeys() {
                throw new Error('ownKeys-boom')
            },
        })
    }
    let proxyTagThrows = () => {
        return new Proxy({ id: 'z1' }, {
            get(t, k) {
                if (k === Symbol.toStringTag) {
                    throw new Error('tag-boom')
                }
                return t[k]
            },
        })
    }

    //optGetterThrows, option之key欄位讀取時拋錯
    let optGetterThrows = (key) => {
        let o = {}
        Object.defineProperty(o, key, {
            get() {
                throw new Error('opt-boom')
            },
            enumerable: true,
        })
        return o
    }

    //inputs, data型之壞輸入(每次呼叫重建, 以便驗證error事件之data引數為呼叫端傳入之同一物件)
    let inputs = [
        { key: 'null-proto Date (field in batch)', mk: () => [{ id: 'z1', secret: MARK, t: nullProtoDate() }] },
        { key: 'null-proto Date (single object)', mk: () => ({ id: 'z1', secret: MARK, t: nullProtoDate() }) },
        { key: 'null-proto Date (3rd record of batch)', mk: () => [{ id: 'z1', secret: MARK }, { id: 'z2' }, { id: 'z3', t: nullProtoDate() }] },
        { key: 'Date with null constructor', mk: () => [{ id: 'z1', secret: MARK, t: nullCtorDate() }] },
        { key: 'throwing getter (nested field)', mk: () => [{ id: 'z1', secret: MARK, o: throwingGetter(new Error('getter-boom')) }] },
        { key: 'deep nesting (stack overflow)', mk: () => [{ id: 'z1', secret: MARK, o: deepObj(50000) }] },
        { key: 'Proxy whose ownKeys throws (iseobj)', mk: proxyOwnKeysThrows },
        { key: 'Proxy whose toStringTag read throws (iseobj)', mk: proxyTagThrows },
        { key: 'one-element array whose [0] getter throws (isearr)', mk: arr1Getter },
    ]

    //inputMsgs, 各壞輸入應原樣通過之訊息(帳本規則2: 訊息為拋出者之原訊息, 不被改寫為泛用訊息; 引擎/lodash之訊息以關鍵字比對, 不綁死版本)
    let inputMsgs = {
        'null-proto Date (field in batch)': /primitive/i,
        'null-proto Date (single object)': /primitive/i,
        'null-proto Date (3rd record of batch)': /primitive/i,
        'Date with null constructor': /constructor/i,
        'throwing getter (nested field)': 'getter-boom',
        'deep nesting (stack overflow)': /call stack/i,
        'Proxy whose ownKeys throws (iseobj)': 'ownKeys-boom',
        'Proxy whose toStringTag read throws (iseobj)': 'tag-boom',
        'one-element array whose [0] getter throws (isearr)': 'elem-getter-boom',
    }

    //thrownValues, 呼叫端存取器拋出之值之型別(帳本規則1: 含拋出值本身無法轉為字串者, error事件仍恰一次): reject之值為拋出者本身, 事件之訊息為字串(msg)
    let thrownValues = [
        { key: 'Error', mk: () => new Error('plain-boom'), msg: 'plain-boom' },
        { key: 'string', mk: () => 'str-boom', msg: 'str-boom' },
        { key: 'number', mk: () => 42, msg: '42' },
        { key: 'null', mk: () => null, msg: 'null' },
        { key: 'undefined', mk: () => undefined, msg: 'undefined' },
        { key: 'null-proto object (not convertible to string)', mk: () => Object.create(null), msg: 'unknown error' },
        {
            key: 'object whose message getter throws',
            mk: () => {
                return {
                    get message() {
                        throw new Error('message-getter-boom')
                    },
                }
            },
            msg: 'unknown error',
        },
        {
            key: 'object whose toString throws',
            mk: () => {
                return {
                    toString() {
                        throw new Error('toString-boom')
                    },
                }
            },
            msg: 'unknown error',
        },
    ]

    //entries, 寫入入口(4格). key為資料庫資料夾用之唯一名稱, valid為可成功寫入(或刪除)之數據
    let entries = [
        { key: 'insert', fn: 'insert', call: (wo, d, o) => wo.insert(d, o), early: () => ({ n: 0, nInserted: 0, ok: 1 }), valid: () => ({ id: 'valid-1' }) },
        { key: 'insertBulk', fn: 'insertBulk', call: (wo, d) => wo.insertBulk(d), early: () => ({ n: 0, nInserted: 0, ok: 1 }), valid: () => ({ id: 'valid-2' }) },
        { key: 'save', fn: 'save', call: (wo, d, o) => wo.save(d, o), early: () => [], valid: () => ({ id: 'valid-3' }) },
        { key: 'del', fn: 'del', call: (wo, d) => wo.del(d), early: () => [], valid: () => ({ id: 'seed1' }) },
    ]

    //optCases, option型之壞輸入(搭配合法data): 讀option亦為try之外之前置處理; sameRef: 事件之data是否為呼叫端傳入之同一物件(insert先讀option再複製故是, save先複製再讀option故為複本)
    let optCases = [
        { fn: 'insert', key: 'option.returnList getter throws', mkOpt: () => optGetterThrows('returnList'), sameRef: true, msg: 'opt-boom' },
        { fn: 'save', key: 'option.autoInsert getter throws', mkOpt: () => optGetterThrows('autoInsert'), sameRef: false, msg: 'opt-boom' },
    ]

    //opened與mk: 於測試資料夾下建立資料庫, after統一關閉
    let opened = []
    let mk = (name, opt = {}) => {
        let wo = WOrm({ url: `${url}/${name}`, db: 'worm', cl: name, ...opt })
        opened.push(wo)
        return wo
    }

    //snap, 資料庫現況(升冪)
    let snap = async(wo) => (await wo.select()).sort((a, b) => (a.id < b.id ? -1 : 1))

    //seed, 寫入前之數據
    let seed = () => [{ id: 'seed1', a: 1 }, { id: 'seed2', a: 2 }]

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

    //chkEv, 錯誤路徑之共同斷言(帳本規則1、4): error事件於reject前恰一次(mode為該入口), 不發change; 回傳該error事件
    let chkEv = (out, entry) => {
        assert.strict.equal(out.ok, false, `${entry.fn} should reject`)
        let evErr = out.evs.filter((v) => v.t === 'error')
        let evChg = out.evs.filter((v) => v.t === 'change')
        assert.strict.equal(evErr.length, 1, `${entry.fn} should emit error exactly once`)
        assert.strict.equal(out.nAtSettle, 1, `${entry.fn} should emit error before reject`)
        assert.strict.equal(evErr[0].settledAtEmit, false, `${entry.fn} should emit error before reject`)
        assert.strict.equal(evErr[0].mode, entry.fn)
        assert.strict.equal(evChg.length, 0, `${entry.fn} should not emit change`)
        return evErr[0]
    }

    //chkData, 事件之data引數(帳本規則4): sameRef為真者須為呼叫端傳入之同一物件(拋錯於複本建立之前); 為假者為複本, 以深度相等比對
    let chkData = (ev, d, sameRef, entry) => {
        if (sameRef) {
            assert.strict.ok(ev.data === d, `${entry.fn} error event data should be the caller's input (no copy exists yet)`)
        }
        else {
            assert.strict.ok(ev.data !== d, `${entry.fn} error event data should be the copy (it exists already), not the caller's object`)
            assert.deepStrictEqual(ev.data, d, `${entry.fn} error event data should equal the caller's input`)
        }
    }

    //chkRej, 拋出者為Error之共同斷言(帳本規則1、2、4): reject為Error, 事件之訊息同reject之message, 事件之data為呼叫端傳入之原值, 訊息不回顯資料值
    let chkRej = (out, entry, d, sameRef, msg) => {
        let ev = chkEv(out, entry)
        assert.strict.ok(out.err instanceof Error, `${entry.fn} should reject with Error`)
        assert.strict.equal(ev.err, out.err.message, `${entry.fn} error event should carry the reject message`)
        //帳本規則2: 訊息為拋出者之原訊息(不被改寫為泛用訊息)
        assert.strict.ok(msg instanceof RegExp ? msg.test(out.err.message) : out.err.message === msg, `${entry.fn} message should be the thrower's own message, got "${out.err.message}"`)
        chkData(ev, d, sameRef, entry)
        assert.strict.ok(!String(out.err.message).includes(MARK), `${entry.fn} message should not echo data values`)
    }

    for (let entry of entries) {
        describe(entry.key, function() {
            let wo = null
            let ob = null
            let nNext = 0

            before(async function() {
                wo = mk(entry.key)
                ob = mkObserver(wo)
                await wo.insertBulk(seed())
            })

            //chkAfter, 失敗後資料庫逐筆不變, 且其後之寫入照常(佇列未被卡住)
            let chkAfter = async(snapBefore) => {
                assert.deepStrictEqual(await snap(wo), snapBefore, `${entry.fn} database should be unchanged`)
                let id = `next-${nNext++}`
                let r = await wo.insert({ id })
                assert.strict.equal(r.nInserted, 1, `${entry.fn} following insert should work`)
            }

            for (let input of inputs) {
                it(`${input.key}: rejects with one error event before reject, no change, database unchanged`, async function() {
                    //對應建議書驗證建議1: 修前紅為無error事件
                    let snapBefore = await snap(wo)
                    let d = input.mk()
                    let out = await ob.run(() => entry.call(wo, d))
                    chkRej(out, entry, d, true, inputMsgs[input.key])
                    await chkAfter(snapBefore)
                })
            }

            for (let oc of optCases.filter((v) => v.fn === entry.fn)) {
                it(`${oc.key}: rejects with one error event before reject, no change, database unchanged`, async function() {
                    let snapBefore = await snap(wo)
                    let d = [{ id: 'o1', secret: MARK, a: 1 }]
                    let out = await ob.run(() => entry.call(wo, d, oc.mkOpt()))
                    chkRej(out, entry, d, oc.sameRef, oc.msg)
                    await chkAfter(snapBefore)
                })
            }

            for (let tv of thrownValues) {
                it(`thrown value (${tv.key}): rejects with the thrown value, one error event with string message "${tv.msg}", no change`, async function() {
                    //帳本規則1: 拋出值本身無法轉為字串者(null原型物件、message存取器拋錯、toString拋錯)亦須恰發出一次error事件(外審agy-opus F-01), reject之值為拋出者本身
                    let snapBefore = await snap(wo)
                    let thrown = tv.mk()
                    let d = [{ id: 'z1', secret: MARK, o: throwingGetter(thrown) }]
                    let out = await ob.run(() => entry.call(wo, d))
                    let ev = chkEv(out, entry)
                    assert.strict.ok(Object.is(out.err, thrown), `${entry.fn} should reject with the thrown value itself`)
                    assert.strict.equal(typeof ev.err, 'string', `${entry.fn} error event message should be a string`)
                    assert.strict.equal(ev.err, tv.msg, `${entry.fn} error event message`)
                    assert.strict.ok(!ev.err.includes(MARK), `${entry.fn} message should not echo data values`)
                    chkData(ev, d, true, entry)
                    await chkAfter(snapBefore)
                })
            }

            if (entry.fn === 'insert') {
                it('bad data with bad option: reports the option error (option is read before the data is copied)', async function() {
                    //insert讀option先於複製data(與修前之讀取順序相同), 兩者皆壞時回報option之錯
                    let snapBefore = await snap(wo)
                    let d = inputs[0].mk()
                    let out = await ob.run(() => wo.insert(d, optGetterThrows('returnList')))
                    chkRej(out, entry, d, true, 'opt-boom')
                    await chkAfter(snapBefore)
                })
                it('invalid data with bad option: still rejects with the option error (option is read before the validity check)', async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => wo.insert(null, optGetterThrows('returnList')))
                    chkRej(out, entry, null, true, 'opt-boom')
                    await chkAfter(snapBefore)
                })
            }

            if (entry.fn === 'save') {
                it('bad data with bad option: reports the data error (data is copied before the option is read)', async function() {
                    //save先複製data再讀option(與修前相同), 兩者皆壞時回報data之錯
                    let snapBefore = await snap(wo)
                    let d = inputs[0].mk()
                    let out = await ob.run(() => wo.save(d, optGetterThrows('autoInsert')))
                    chkRej(out, entry, d, true, /primitive/i)
                    assert.strict.notEqual(out.err.message, 'opt-boom')
                    await chkAfter(snapBefore)
                })
                it('invalid data with bad option: returns [] without reading the option (control, unchanged)', async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => wo.save(null, optGetterThrows('autoInsert')))
                    assert.strict.equal(out.ok, true)
                    assert.deepStrictEqual(out.val, [])
                    assert.strict.equal(out.evs.length, 0)
                    await chkAfter(snapBefore)
                })
            }
        })
    }

    //對照組(修前即綠): 帳本規則3, 輸入無效之早退結果不變, 不發任何事件
    describe('control: invalid input returns early (unchanged)', function() {
        let invalids = [
            { key: 'null', v: null },
            { key: 'undefined', v: undefined },
            { key: 'string', v: 'str' },
            { key: 'number', v: 123 },
            { key: 'empty array', v: [] },
            { key: 'empty object', v: {} },
            { key: 'null-proto Date as data (not an object/array, so invalid input)', v: nullProtoDate() },
        ]
        for (let entry of entries) {
            describe(entry.fn, function() {
                let wo = null
                let ob = null
                before(async function() {
                    wo = mk(`early-${entry.key}`)
                    ob = mkObserver(wo)
                    await wo.insertBulk(seed())
                })
                for (let inv of invalids) {
                    it(`${inv.key}: resolves ${JSON.stringify(entry.early())}, no events, database unchanged`, async function() {
                        let snapBefore = await snap(wo)
                        let out = await ob.run(() => entry.call(wo, inv.v))
                        assert.strict.equal(out.ok, true)
                        assert.deepStrictEqual(out.val, entry.early())
                        assert.strict.equal(out.evs.length, 0)
                        assert.deepStrictEqual(await snap(wo), snapBefore)
                    })
                }
            })
        }
        describe('insert with returnList:true', function() {
            let wo = null
            let ob = null
            before(function() {
                wo = mk('early-insert-list')
                ob = mkObserver(wo)
            })
            for (let inv of invalids) {
                it(`${inv.key}: resolves [], no events`, async function() {
                    let out = await ob.run(() => wo.insert(inv.v, { returnList: true }))
                    assert.strict.equal(out.ok, true)
                    assert.deepStrictEqual(out.val, [])
                    assert.strict.equal(out.evs.length, 0)
                })
            }
        })
    })

    //對照組(修前即綠): 一般輸入之行為不變, error為0次, change為各入口原有之事件
    describe('control: normal input unchanged', function() {
        let cases = [
            { fn: 'insert', call: (wo) => wo.insert({ id: 'n1', a: 1 }), val: { n: 1, nInserted: 1, ok: 1 }, changes: ['insert'] },
            { fn: 'insertBulk', call: (wo) => wo.insertBulk([{ id: 'n1', a: 1 }, { id: 'n2', a: 2 }]), val: { n: 2, nInserted: 2, ok: 1 }, changes: ['insertBulk'] },
            { fn: 'save', call: (wo) => wo.save({ id: 'n1', a: 1 }), val: [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }], changes: ['insert', 'save'] },
            { fn: 'del', call: (wo) => wo.del({ id: 'seed1' }), val: [{ n: 1, nDeleted: 1, ok: 1 }], changes: ['del'] },
        ]
        for (let c of cases) {
            it(`${c.fn}: resolves, no error event, change events ${JSON.stringify(c.changes)}`, async function() {
                let wo = mk(`normal-${c.fn}`)
                let ob = mkObserver(wo)
                await wo.insertBulk(seed())
                let out = await ob.run(() => c.call(wo))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(out.val, c.val)
                assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0)
                assert.deepStrictEqual(out.evs.filter((v) => v.t === 'change').map((v) => v.mode), c.changes)
            })
        }
    })

    //useCache之快取(帳本規則3、5): 前置處理失敗與其他整批性錯誤一致須重設快取, 輸入無效之早退不重設
    //觀測法: level持有資料夾之獨佔鎖, 無法自實例外改動資料, 故改計select實際走訪資料庫(client.iterator)之次數: 快取命中不走訪, 快取已重設則下次select走訪一次
    describe('useCache: a failed write resets the cache, an early return keeps it (external review agy-opus F-02)', function() {
        let nIter = 0
        let hadOwn = Object.prototype.hasOwnProperty.call(Level.prototype, 'iterator')
        let orig = Level.prototype.iterator

        before(function() {
            Level.prototype.iterator = function(...args) {
                nIter++
                return orig.apply(this, args)
            }
        })

        after(function() {
            if (hadOwn) {
                Level.prototype.iterator = orig
            }
            else {
                delete Level.prototype.iterator
            }
        })

        for (let entry of entries) {
            describe(entry.fn, function() {
                let wo = null

                //hot, 令快取為熱, 回傳此時之走訪次數
                let hot = async() => {
                    await wo.select()
                    return nIter
                }

                before(async function() {
                    wo = mk(`cache-reset-${entry.key}`, { useCache: true })
                    await wo.insertBulk(seed())
                })

                it('control: a second select hits the cache (no database scan)', async function() {
                    let n0 = await hot()
                    await wo.select()
                    assert.strict.equal(nIter, n0)
                })

                it('control: a successful write resets the cache (next select scans the database)', async function() {
                    let n0 = await hot()
                    await entry.call(wo, entry.valid())
                    await wo.select()
                    assert.strict.equal(nIter, n0 + 1)
                })

                it('a write rejected by bad input resets the cache (next select scans the database)', async function() {
                    let n0 = await hot()
                    await entry.call(wo, inputs[0].mk()).then(() => assert.fail('should reject'), () => {})
                    await wo.select()
                    assert.strict.equal(nIter, n0 + 1)
                })

                it('an early return (invalid input) keeps the cache (next select does not scan)', async function() {
                    let n0 = await hot()
                    await entry.call(wo, null)
                    await wo.select()
                    assert.strict.equal(nIter, n0)
                })
            })
        }
    })

    //對照組(修前即綠): useCache熱快取後前置處理失敗, 再select與先前一致(失敗不使快取失真)
    describe('control: useCache stays coherent after a failed write', function() {
        for (let entry of entries) {
            it(`${entry.fn}: select after failure equals select before`, async function() {
                let wo = mk(`cache-${entry.key}`, { useCache: true })
                await wo.insertBulk(seed())
                let before = await snap(wo) //填入快取
                let d = inputs[0].mk()
                await entry.call(wo, d).then(() => assert.fail('should reject'), () => {})
                assert.deepStrictEqual(await snap(wo), before)
            })
        }
    })

    //對照組(修前即綠): 已關閉先於前置處理(帳本規則3), 壞輸入於已關閉實例仍為closed訊息, error事件恰一次
    describe('control: closed takes precedence over input errors', function() {
        for (let entry of entries) {
            it(`${entry.fn}: rejects with closed message, one error event`, async function() {
                let wo = mk(`closed-${entry.key}`)
                let ob = mkObserver(wo)
                await wo.insertBulk(seed())
                await wo.close()
                let d = inputs[0].mk()
                let out = await ob.run(() => entry.call(wo, d))
                assert.strict.equal(out.ok, false)
                assert.strict.ok(String(out.err.message).includes('closed'))
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1)
                assert.strict.equal(evErr[0].mode, entry.fn)
                assert.strict.ok(String(evErr[0].err).includes('closed'))
            })
        }
    })

})
