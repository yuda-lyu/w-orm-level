import assert from 'assert'
import w from 'wsemi'
import { Level } from 'level'
import WOrm from '../src/WOrmLevel.mjs'
import { mkObserver } from './lib/mkObserver.mjs'
import { arr1Getter, proxyOwnKeysThrows, proxyTagThrows, proxyRevoked, proxyGopdThrows, proxyProtoThrows, protoChainOwnKeysThrows, arrLenThrows, arrRevoked } from './lib/hostile.mjs'


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

    //敵意值(arr1Getter、proxyOwnKeysThrows、proxyTagThrows、proxyRevoked、proxyGopdThrows、proxyProtoThrows、protoChainOwnKeysThrows、arrLenThrows、arrRevoked)取自test/lib/hostile.mjs(帳本R-PROBE-01):
    //wsemi 1.9.69起判斷函數對讀取即拋錯之值回false而不拋錯, 這些「不可讀」之data仍須走同一錯誤路徑, 不可被當成輸入無效而早退

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
        { key: 'revoked Proxy (iseobj)', mk: proxyRevoked },
        { key: 'Proxy whose getOwnPropertyDescriptor throws (iseobj)', mk: proxyGopdThrows },
        { key: 'Proxy whose getPrototypeOf throws (iseobj)', mk: proxyProtoThrows },
        { key: 'array Proxy whose length read throws (isearr)', mk: arrLenThrows },
        { key: 'revoked array Proxy (isarr)', mk: arrRevoked },
        { key: 'object whose prototype is a Proxy whose ownKeys throws (iseobj for...in)', mk: protoChainOwnKeysThrows },
    ]

    //RD, 各壞輸入應通過之訊息(w-orm系列對齊口徑A2、A3; 帳本R-PROBE-01、R-WRITE-ERR-01規則2): 呼叫端給的值讀取即拋錯(複製階段拋錯之巢狀不可讀值、原型為null之Date、過深之巢狀、存取器拋錯,
    //或data容器本身不可讀)一律為固定詞彙invalid data: must be a readable value, 不含拋出者之原訊息(2026-11-20 oro557b2起; 原為拋出者之原訊息), 複製處不分辨頂層與巢狀
    let RD = 'invalid data: must be a readable value'
    let inputMsgs = {
        'null-proto Date (field in batch)': RD,
        'null-proto Date (single object)': RD,
        'null-proto Date (3rd record of batch)': RD,
        'Date with null constructor': RD,
        'throwing getter (nested field)': RD,
        'deep nesting (stack overflow)': RD,
        'Proxy whose ownKeys throws (iseobj)': RD,
        'Proxy whose toStringTag read throws (iseobj)': RD,
        'one-element array whose [0] getter throws (isearr)': RD,
        'revoked Proxy (iseobj)': RD,
        'Proxy whose getOwnPropertyDescriptor throws (iseobj)': RD,
        'Proxy whose getPrototypeOf throws (iseobj)': RD,
        'array Proxy whose length read throws (isearr)': RD,
        'revoked array Proxy (isarr)': RD,
        'object whose prototype is a Proxy whose ownKeys throws (iseobj for...in)': RD,
    }

    //leaks, 原例外文字(引擎/lodash/呼叫端之拋出文字): 固定詞彙訊息不得含之(V20, 帳本規則2)
    let leaks = /primitive|constructor|boom|call stack|revoked|Cannot/i

    //thrownValues, 呼叫端存取器拋出之值之型別(含拋出值本身無法轉為字串者, error事件仍恰一次): 不論拋出何種值, reject一律為固定詞彙之本套件Error(A3, 不轉出拋出者之文字、不交出拋出者本身), 事件之訊息為同一字串
    let thrownValues = [
        { key: 'Error', mk: () => new Error('plain-boom') },
        { key: 'string', mk: () => 'str-boom' },
        { key: 'number', mk: () => 42 },
        { key: 'null', mk: () => null },
        { key: 'undefined', mk: () => undefined },
        { key: 'null-proto object (not convertible to string)', mk: () => Object.create(null) },
        {
            key: 'object whose message getter throws',
            mk: () => {
                return {
                    get message() {
                        throw new Error('message-getter-boom')
                    },
                }
            },
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
        },
    ]

    //entries, 寫入入口(4格). key為資料庫資料夾用之唯一名稱, valid為可成功寫入(或刪除)之數據
    let entries = [
        { key: 'insert', fn: 'insert', call: (wo, d, o) => wo.insert(d, o), early: () => ({ n: 0, nInserted: 0, ok: 1 }), valid: () => ({ id: 'valid-1' }) },
        { key: 'insertBulk', fn: 'insertBulk', call: (wo, d) => wo.insertBulk(d), early: () => ({ n: 0, nInserted: 0, ok: 1 }), valid: () => ({ id: 'valid-2' }) },
        { key: 'save', fn: 'save', call: (wo, d, o) => wo.save(d, o), early: () => [], valid: () => ({ id: 'valid-3' }) },
        { key: 'del', fn: 'del', call: (wo, d) => wo.del(d), early: () => [], valid: () => ({ id: 'seed1' }) },
    ]

    //optCases, option型之壞輸入(搭配合法data): 讀option亦為try之外之前置處理; 成員為拋錯之存取器者轉固定詞彙invalid option.<鍵>: must be a readable value(A2, 不轉出拋出者之文字), error事件之data為null(A4)
    let optCases = [
        { fn: 'insert', key: 'option.returnList getter throws', mkOpt: () => optGetterThrows('returnList'), msg: 'invalid option.returnList: must be a readable value' },
        { fn: 'save', key: 'option.autoInsert getter throws', mkOpt: () => optGetterThrows('autoInsert'), msg: 'invalid option.autoInsert: must be a readable value' },
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

    //chkData, 事件之data引數(w-orm系列對齊口徑A4): 入口階段(讀取option或data、複製data)之拒絕為null, 不把不可讀之值或含其之複本交給訂閱函數
    let chkData = (ev, entry) => {
        //以ok而非equal斷言null: 失敗時data可能為不可讀之Proxy, equal之失敗訊息會inspect它而使mocha序列化失敗
        assert.strict.ok(ev.data === null, `${entry.fn} error event data should be null (entry-stage rejection)`)
    }

    //chkRej, 共同斷言(帳本規則1、2、4; A2~A4): reject為本套件之Error, 訊息為指定之固定詞彙(不含拋出者之原訊息與資料值), 事件之訊息同reject之message, 事件之data為null
    let chkRej = (out, entry, msg) => {
        let ev = chkEv(out, entry)
        assert.strict.ok(out.err instanceof Error, `${entry.fn} should reject with Error`)
        assert.strict.equal(ev.err, out.err.message, `${entry.fn} error event should carry the reject message`)
        assert.strict.equal(out.err.message, msg, `${entry.fn} message should be the fixed readable-value message, got "${out.err.message}"`)
        assert.strict.ok(!leaks.test(out.err.message), `${entry.fn} message should not echo the thrower's text`)
        chkData(ev, entry)
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
                    chkRej(out, entry, inputMsgs[input.key])
                    await chkAfter(snapBefore)
                })
            }

            for (let oc of optCases.filter((v) => v.fn === entry.fn)) {
                it(`${oc.key}: rejects with the fixed message, one error event before reject (data null), no change, database unchanged`, async function() {
                    let snapBefore = await snap(wo)
                    let d = [{ id: 'o1', secret: MARK, a: 1 }]
                    let out = await ob.run(() => entry.call(wo, d, oc.mkOpt()))
                    chkRej(out, entry, oc.msg)
                    await chkAfter(snapBefore)
                })
            }

            for (let tv of thrownValues) {
                it(`thrown value (${tv.key}) at the copy stage: rejects with the fixed message (the thrown value is neither echoed nor handed out), one error event with the same string message and data null, no change`, async function() {
                    //A3: 呼叫端存取器於複製階段拋出任何型別之值(含無法轉為字串者: null原型物件、message存取器拋錯、toString拋錯), 一律轉固定詞彙, error事件仍恰一次, data為null
                    let snapBefore = await snap(wo)
                    let thrown = tv.mk()
                    let d = [{ id: 'z1', secret: MARK, o: throwingGetter(thrown) }]
                    let out = await ob.run(() => entry.call(wo, d))
                    let ev = chkEv(out, entry)
                    assert.strict.ok(!Object.is(out.err, thrown), `${entry.fn} should not reject with the thrown value itself`)
                    assert.strict.ok(out.err instanceof Error)
                    assert.strict.equal(out.err.message, RD)
                    assert.strict.equal(typeof ev.err, 'string', `${entry.fn} error event message should be a string`)
                    assert.strict.equal(ev.err, RD, `${entry.fn} error event message`)
                    assert.strict.ok(!leaks.test(ev.err) && !ev.err.includes(MARK), `${entry.fn} message should not echo the thrower's text or data values`)
                    chkData(ev, entry)
                    await chkAfter(snapBefore)
                })
            }

            if (entry.fn === 'insert') {
                it('bad data with bad option: reports the option error (option is read before the data is copied)', async function() {
                    //insert讀option先於複製data(與修前之讀取順序相同), 兩者皆壞時回報option之錯
                    let snapBefore = await snap(wo)
                    let d = inputs[0].mk()
                    let out = await ob.run(() => wo.insert(d, optGetterThrows('returnList')))
                    chkRej(out, entry, 'invalid option.returnList: must be a readable value')
                    await chkAfter(snapBefore)
                })
                it('invalid data with bad option: still rejects with the option error (option is read before the validity check)', async function() {
                    let snapBefore = await snap(wo)
                    let out = await ob.run(() => wo.insert(null, optGetterThrows('returnList')))
                    chkRej(out, entry, 'invalid option.returnList: must be a readable value')
                    await chkAfter(snapBefore)
                })
            }

            if (entry.fn === 'save') {
                it('bad data with bad option: reports the data error (data is copied before the option is read)', async function() {
                    //save先複製data再讀option(與修前相同), 兩者皆壞時回報data之錯
                    let snapBefore = await snap(wo)
                    let d = inputs[0].mk()
                    let out = await ob.run(() => wo.save(d, optGetterThrows('autoInsert')))
                    chkRej(out, entry, RD)
                    assert.strict.notEqual(out.err.message, 'invalid option.autoInsert: must be a readable value')
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
