import assert from 'assert'
import fs from 'fs'
import w from 'wsemi'
import isearr from 'wsemi/src/isearr.mjs'
import cloneDeep from 'lodash-es/cloneDeep.js'
import WOrm from '../src/WOrmLevel.mjs'
import { probeTag, probeReadable } from '../src/probeReadable.mjs'
import { mkObserver } from './lib/mkObserver.mjs'
import { arr1Getter, proxyOwnKeysThrows, proxyTagThrows, proxyRevoked, proxyGopdThrows, proxyProtoThrows, protoChainOwnKeysThrows, symbolOnlyGopdThrows, arrLenThrows, arrRevoked } from './lib/hostile.mjs'


//呼叫端給的值之可讀性探針(帳本R-PROBE-01): wsemi 1.9.69起判斷函數(isestr、isbol、iseobj、isearr等)對讀取即拋錯之值(已撤銷之Proxy、Symbol.toStringTag或陷阱拋錯者、元素存取器拋錯之陣列等)
//回false而不拋錯, 本套件原借判斷函數之拋錯而成立之防線改由明確之探針(src/probeReadable.mjs)判定. 規則(各案註解之[規則N]):
//  1. 站點之判斷函數回false時以探針分辨[不可讀]與[可讀而型別不符], 不可讀者走該站點之原失敗通道: 寫入入口(寫入方法之data、option.returnList與id)與selectByPk(pk)為error事件恰一次且先於reject、不發change、資料庫不變、其後之佇列照常;
//     建構層(opt.url、db、cl、useCache、autoGenPk)為同步throw原錯誤、不建立資料夾
//  2. 訊息為拋出者之原訊息(不被改寫)
//  3. 可讀而型別不符者行為不變: data走輸入無效早退(n:0或[]), pk回null, returnList、useCache、autoGenPk、db、cl採忽略(預設)
//  4. 探針不呼叫存取器(陣列length為1時讀[0]為唯一例外, 同isearr之依賴); 判斷函數回true(有效輸入)時不探針, 不增加其讀取次數
//  5. 內部值(cloneDeep之複本之自有欄位、資料庫讀出值、錯誤物件之message)不探針; 惟複本保留原型, 經原型存取器讀出之id仍屬呼叫端給的值(procPk站點)
//寫入方法之data站點(insert、insertBulk、save、del)之敵意輸入案見unit-write-pre-error
describe('probe-readable', function() {
    let url = './test/_tmp/probe-readable'

    //opened與mk: 於測試資料夾下建立資料庫, after統一關閉
    let opened = []
    let mk = (name, opt = {}) => {
        let wo = WOrm({ url: `${url}/${name}`, db: 'worm', cl: name, ...opt })
        opened.push(wo)
        return wo
    }
    //proxyHasThrows, 僅has陷阱拋錯(型別標籤可讀)
    let proxyHasThrows = () => {
        return new Proxy({}, {
            has() {
                throw new Error('has-boom')
            },
        })
    }
    let snap = async(wo) => (await wo.select()).sort((a, b) => (a.id < b.id ? -1 : 1))
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

    //hostiles, 敵意值全集: tag為probeTag是否拋錯(型別標籤不可讀), msg為拋出者之原訊息
    let hostiles = [
        { key: 'revoked Proxy', mk: proxyRevoked, tag: true, msg: /revoked/i },
        { key: 'Proxy whose toStringTag read throws', mk: proxyTagThrows, tag: true, msg: 'tag-boom' },
        { key: 'Proxy whose ownKeys throws', mk: proxyOwnKeysThrows, tag: false, msg: 'ownKeys-boom' },
        { key: 'Proxy whose getOwnPropertyDescriptor throws', mk: proxyGopdThrows, tag: false, msg: 'gopd-boom' },
        { key: 'Proxy whose getPrototypeOf throws', mk: proxyProtoThrows, tag: false, msg: 'proto-boom' },
        { key: 'one-element array whose [0] getter throws', mk: arr1Getter, tag: false, msg: 'elem-getter-boom' },
        { key: 'array Proxy whose length read throws', mk: arrLenThrows, tag: false, msg: 'len-boom' },
        { key: 'revoked array Proxy', mk: arrRevoked, tag: true, msg: /revoked/i },
        { key: 'object whose prototype is a Proxy whose ownKeys throws', mk: protoChainOwnKeysThrows, tag: false, msg: 'ownKeys-boom' },
    ]
    let chkMsg = (err, msg) => {
        assert.strict.ok(err instanceof Error, 'should throw the original Error')
        assert.strict.ok(msg instanceof RegExp ? msg.test(err.message) : err.message === msg, `message should be the thrower's own message, got "${err.message}"`)
    }

    describe('probe functions (src/probeReadable.mjs)', function() {
        //可讀值: 純量、一般物件、陣列、特殊物件與不改變行為之透明Proxy
        let readables = [
            { key: 'undefined', mk: () => undefined },
            { key: 'null', mk: () => null },
            { key: 'number', mk: () => 123 },
            { key: 'empty string', mk: () => '' },
            { key: 'string', mk: () => 'abc' },
            { key: 'boolean', mk: () => true },
            { key: 'symbol', mk: () => Symbol('s') },
            { key: 'bigint', mk: () => 12n },
            { key: 'plain object', mk: () => ({ id: 'a', n: { x: 1 } }) },
            { key: 'null-proto object', mk: () => Object.assign(Object.create(null), { id: 'a' }) },
            { key: 'empty array', mk: () => [] },
            { key: 'one-element array', mk: () => [{ id: 'a' }] },
            { key: 'two-element array', mk: () => [{ id: 'a' }, { id: 'b' }] },
            { key: 'Date', mk: () => new Date(0) },
            { key: 'null-proto Date', mk: () => Object.setPrototypeOf(new Date(0), null) },
            { key: 'Buffer', mk: () => Buffer.from('abc') },
            { key: 'Map', mk: () => new Map([[1, 2]]) },
            { key: 'function', mk: () => function() {} },
            { key: 'transparent Proxy (object)', mk: () => new Proxy({ id: 'a' }, {}) },
            { key: 'transparent Proxy (array)', mk: () => new Proxy([{ id: 'a' }], {}) },
            { key: 'Proxy with only Symbol keys whose getOwnPropertyDescriptor throws (for...in ignores Symbol keys)', mk: symbolOnlyGopdThrows },
        ]
        for (let r of readables) {
            it(`readable (${r.key}): neither probe throws [rule 1: readable values are not rejected]`, function() {
                assert.strict.doesNotThrow(() => probeTag(r.mk()))
                assert.strict.doesNotThrow(() => probeReadable(r.mk()))
            })
        }

        it('probeTag returns the internal tag [rule 1]', function() {
            assert.strict.equal(probeTag({}), '[object Object]')
            assert.strict.equal(probeTag([]), '[object Array]')
            assert.strict.equal(probeTag('s'), '[object String]')
            assert.strict.equal(probeTag(null), '[object Null]')
        })

        for (let h of hostiles) {
            it(`${h.key}: probeReadable throws the original error [rules 1, 2]`, function() {
                assert.strict.throws(() => probeReadable(h.mk()), (err) => {
                    chkMsg(err, h.msg)
                    return true
                })
            })
            it(`${h.key}: probeTag ${h.tag ? 'throws the original error' : 'does not throw (only the type tag is read)'} [rules 1, 2]`, function() {
                if (h.tag) {
                    assert.strict.throws(() => probeTag(h.mk()), (err) => {
                        chkMsg(err, h.msg)
                        return true
                    })
                }
                else {
                    assert.strict.doesNotThrow(() => probeTag(h.mk()))
                }
            })
        }

        it('does not call accessors of a plain object [rule 4]', function() {
            let n = 0
            let o = {
                get a() {
                    n++
                    return 1
                },
                b: 2,
            }
            probeReadable(o)
            assert.strict.equal(n, 0)
        })

        it('reads [0] of a one-element array exactly once, and no other element [rule 4: the only exception, same as isearr]', function() {
            let n0 = 0
            let n1 = 0
            let cnt0 = () => {
                n0++
                return 1
            }
            let cnt1 = () => {
                n1++
                return 1
            }
            let a = [0]
            Object.defineProperty(a, '0', { get: cnt0, enumerable: true })
            probeReadable(a)
            assert.strict.equal(n0, 1)
            let b = [0, 0]
            Object.defineProperty(b, '0', { get: cnt0, enumerable: true })
            Object.defineProperty(b, '1', { get: cnt1, enumerable: true })
            probeReadable(b)
            assert.strict.equal(n0, 1, 'elements of a longer array are not read by the probe')
            assert.strict.equal(n1, 0)
        })
    })

    describe('selectByPk(pk) site', function() {
        let wo = null
        let ob = null
        before(async function() {
            wo = mk('bypk')
            ob = mkObserver(wo)
            await wo.insertBulk(seed())
        })

        for (let h of hostiles.filter((v) => v.tag)) {
            it(`${h.key} as pk: rejects with the original message, one error event before reject, no change, database unchanged [rules 1, 2]`, async function() {
                let snapBefore = await snap(wo)
                let out = await ob.run(() => wo.selectByPk(h.mk()))
                assert.strict.equal(out.ok, false, 'selectByPk should reject')
                chkMsg(out.err, h.msg)
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1, 'selectByPk should emit error exactly once')
                assert.strict.equal(out.nAtSettle, 1, 'selectByPk should emit error before reject')
                assert.strict.equal(evErr[0].settledAtEmit, false)
                assert.strict.equal(evErr[0].mode, 'selectByPk')
                assert.strict.equal(evErr[0].err, out.err.message)
                assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0)
                assert.deepStrictEqual(await snap(wo), snapBefore)
                assert.deepStrictEqual(await wo.selectByPk('seed1'), { id: 'seed1', a: 1 }, 'following selectByPk should work (queue not stuck)')
            })
        }

        //可讀而型別不符(含僅在列鍵等陷阱拋錯者: 型別標籤可讀, 同修前之isestr僅讀標籤)者回null, 不發事件 [rule 3]
        let wrongTypes = [
            { key: 'number', mk: () => 123 },
            { key: 'null', mk: () => null },
            { key: 'undefined', mk: () => undefined },
            { key: 'empty string', mk: () => '' },
            { key: 'plain object', mk: () => ({ id: 'seed1' }) },
            { key: 'array', mk: () => ['seed1'] },
            { key: 'Proxy whose ownKeys throws (tag readable)', mk: proxyOwnKeysThrows },
            { key: 'Proxy whose getOwnPropertyDescriptor throws (tag readable)', mk: proxyGopdThrows },
        ]
        for (let t of wrongTypes) {
            it(`${t.key} as pk: resolves null, no events [rule 3]`, async function() {
                let out = await ob.run(() => wo.selectByPk(t.mk()))
                assert.strict.equal(out.ok, true)
                assert.strict.equal(out.val, null)
                assert.strict.equal(out.evs.length, 0)
            })
        }
    })

    describe('insert option.returnList site', function() {
        let wo = null
        let ob = null
        let nNext = 0
        before(async function() {
            wo = mk('returnlist')
            ob = mkObserver(wo)
            await wo.insertBulk(seed())
        })

        for (let h of hostiles.filter((v) => v.tag)) {
            it(`${h.key} as returnList: rejects with the original message, one error event before reject (data is the caller's input), no change, database unchanged [rules 1, 2]`, async function() {
                let snapBefore = await snap(wo)
                let d = [{ id: 'rl-bad', a: 1 }]
                let out = await ob.run(() => wo.insert(d, { returnList: h.mk() }))
                assert.strict.equal(out.ok, false, 'insert should reject')
                chkMsg(out.err, h.msg)
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1, 'insert should emit error exactly once')
                assert.strict.equal(out.nAtSettle, 1, 'insert should emit error before reject')
                assert.strict.equal(evErr[0].settledAtEmit, false)
                assert.strict.equal(evErr[0].mode, 'insert')
                assert.strict.equal(evErr[0].err, out.err.message)
                assert.strict.ok(evErr[0].data === d, 'error event data should be the caller input (the copy is made after the option is read)')
                assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0)
                assert.deepStrictEqual(await snap(wo), snapBefore)
            })
        }

        //可讀而型別不符者採忽略(returnList為預設false): 照常寫入, 回聚合物件, 一個change事件 [rule 3]
        let wrongTypes = [
            { key: 'string', mk: () => 'yes' },
            { key: 'number', mk: () => 1 },
            { key: 'plain object', mk: () => ({}) },
            { key: 'array', mk: () => [] },
            { key: 'Proxy whose ownKeys throws (tag readable)', mk: proxyOwnKeysThrows },
            { key: 'Proxy whose getOwnPropertyDescriptor throws (tag readable)', mk: proxyGopdThrows },
            { key: 'Proxy whose has trap throws (known boundary: tag readable, formerly rejected through lodash isBoolean; see rulebook R-PROBE-01)', mk: proxyHasThrows },
        ]
        for (let t of wrongTypes) {
            it(`${t.key} as returnList: ignored (default false), writes normally, one change event, no error event [rule 3]`, async function() {
                let id = `rl-ok-${nNext++}`
                let out = await ob.run(() => wo.insert({ id, a: 1 }, { returnList: t.mk() }))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(out.val, { n: 1, nInserted: 1, ok: 1 })
                assert.deepStrictEqual(out.evs.map((v) => `${v.t}:${v.mode}`), ['change:insert'])
                assert.deepStrictEqual(await wo.selectByPk(id), { id, a: 1 })
            })
        }
    })

    describe('constructor opt site', function() {
        let n = 0
        let base = (name) => ({ url: `${url}/ctor-${name}-${n++}`, db: 'worm', cl: 'c' })

        for (let key of ['url', 'db', 'cl', 'useCache', 'autoGenPk']) {
            for (let h of hostiles.filter((v) => v.tag)) {
                it(`opt.${key} = ${h.key}: throws the original error synchronously${key === 'url' ? '' : ', creates no folder'} [rules 1, 2]`, function() {
                    let opt = base(key)
                    opt[key] = h.mk()
                    let wo = null
                    let thrown = null
                    try {
                        wo = WOrm(opt)
                    }
                    catch (err) {
                        thrown = err
                    }
                    if (wo !== null) {
                        opened.push(wo)
                    }
                    assert.strict.ok(thrown !== null, 'constructor should throw')
                    chkMsg(thrown, h.msg)
                    if (key !== 'url') {
                        assert.strict.equal(fs.existsSync(opt.url), false, 'no database folder should be created')
                    }
                })
            }
        }

        //可讀而型別不符者採忽略(本套件慣例) [rule 3]; url之預設位址為相對cwd之./_db, 與其他測試檔共用, 不在此測
        it('readable wrong-typed db and cl: ignored (defaults worm/test), constructs and works [rule 3]', async function() {
            let opt = base('wrong-dbcl')
            let wo = WOrm({ ...opt, db: 123, cl: 456 })
            await wo.insert({ id: 'x1', a: 1 })
            await wo.close()
            let wo2 = WOrm({ url: opt.url }) //預設db為worm、cl為test: 與上者同一資料表
            opened.push(wo2)
            assert.deepStrictEqual(await wo2.select(), [{ id: 'x1', a: 1 }])
        })
        it('readable wrong-typed autoGenPk: ignored (default true), a record without id gets one [rule 3]', async function() {
            let wo = mk('wrong-pk', { autoGenPk: 'no' })
            let r = await wo.insert({ a: 1 })
            assert.strict.equal(r.nInserted, 1)
        })
        it('readable wrong-typed useCache: ignored (default false), constructs and works [rule 3]', async function() {
            let wo = mk('wrong-cache', { useCache: 'yes' })
            await wo.insert({ id: 'x1', a: 1 })
            assert.deepStrictEqual(await wo.select(), [{ id: 'x1', a: 1 }])
        })
        it('Proxy whose ownKeys throws as useCache/autoGenPk/db/cl (tag readable): constructs [rule 3]', async function() {
            let wo = mk('wrong-proxy', { useCache: proxyOwnKeysThrows(), autoGenPk: proxyOwnKeysThrows() })
            await wo.insert({ id: 'x1', a: 1 })
            assert.deepStrictEqual(await wo.select(), [{ id: 'x1', a: 1 }])
        })
    })

    //透明Proxy為可讀: 寫入方法照常處理(探針不得多拒收) [rules 1, 3]
    describe('readable Proxy data is not rejected by the probe', function() {
        let cases = [
            { fn: 'insert', call: (wo) => wo.insert(new Proxy({ id: 'p1', a: 1 }, {})), val: { n: 1, nInserted: 1, ok: 1 }, changes: ['insert'] },
            { fn: 'insertBulk', call: (wo) => wo.insertBulk(new Proxy([{ id: 'p1', a: 1 }, { id: 'p2', a: 2 }], {})), val: { n: 2, nInserted: 2, ok: 1 }, changes: ['insertBulk'] },
            { fn: 'save', call: (wo) => wo.save(new Proxy({ id: 'p1', a: 1 }, {})), val: [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }], changes: ['insert', 'save'] },
            { fn: 'del', call: (wo) => wo.del(new Proxy({ id: 'seed1' }, {})), val: [{ n: 1, nDeleted: 1, ok: 1 }], changes: ['del'] },
        ]
        for (let c of cases) {
            it(`${c.fn}: transparent Proxy data writes normally, no error event`, async function() {
                let wo = mk(`proxy-${c.fn}`)
                let ob = mkObserver(wo)
                await wo.insertBulk(seed())
                let out = await ob.run(() => c.call(wo))
                assert.strict.equal(out.ok, true)
                assert.deepStrictEqual(out.val, c.val)
                assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0)
                assert.deepStrictEqual(out.evs.filter((v) => v.t === 'change').map((v) => v.mode), c.changes)
            })
        }
        it('insert: transparent Proxy of an empty array is invalid input (early return n:0, no events)', async function() {
            let wo = mk('proxy-empty')
            let ob = mkObserver(wo)
            let out = await ob.run(() => wo.insert(new Proxy([], {})))
            assert.strict.equal(out.ok, true)
            assert.deepStrictEqual(out.val, { n: 0, nInserted: 0, ok: 1 })
            assert.strict.equal(out.evs.length, 0)
        })
        it('insert: a Proxy with only Symbol keys whose getOwnPropertyDescriptor throws is readable (for...in ignores Symbol keys): invalid input, early return n:0, no events [rule 3]', async function() {
            let wo = mk('proxy-symbol-only')
            let ob = mkObserver(wo)
            let out = await ob.run(() => wo.insert(symbolOnlyGopdThrows()))
            assert.strict.equal(out.ok, true)
            assert.deepStrictEqual(out.val, { n: 0, nInserted: 0, ok: 1 })
            assert.strict.equal(out.evs.length, 0)
        })
    })

    //有效輸入不探針(規則4): 判斷函數回true者之讀取次數同修前(判定一次＋cloneDeep), 探針不得多讀一次(有狀態之存取器不被多執行)
    describe('valid data is not probed (no extra read)', function() {
        let mkCounting = (id) => {
            let c = { n: 0 }
            let a = [0]
            Object.defineProperty(a, '0', {
                get() {
                    c.n++
                    return { id, a: 1 }
                },
                enumerable: true,
            })
            return { a, c }
        }
        let base = mkCounting('b0')
        isearr(base.a)
        cloneDeep(base.a)
        for (let fn of ['insert', 'insertBulk', 'save', 'del']) {
            it(`${fn}: one-element array data with a counting [0] getter is read exactly as often as isearr + cloneDeep (${base.c.n})`, async function() {
                let wo = mk(`reads-${fn}`)
                let t = mkCounting(`r-${fn}`)
                await wo[fn](t.a)
                assert.strict.equal(t.c.n, base.c.n)
            })
        }
    })

    //id經原型存取器讀出(規則5): cloneDeep保留原型, 類別實例原型上之id存取器於複本上仍執行呼叫端之程式, 其回傳不可讀之值者走錯誤路徑(原訊息), 不被當成未帶id
    describe('id read through a prototype accessor (procPk site)', function() {
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
            for (let fn of ['insert', 'insertBulk', 'save']) {
                for (let h of hostiles.filter((v) => v.tag)) {
                    it(`${fn} (autoGenPk ${apk}): prototype getter id returns ${h.key}: rejects with the original message, one error event before reject, no change, database unchanged [rules 1, 2, 5]`, async function() {
                        let wo = mk(`pid-${fn}-${apk}-${h.key.replace(/\W+/g, '_')}`, { autoGenPk: apk })
                        let ob = mkObserver(wo)
                        await wo.insertBulk(seed())
                        let snapBefore = await snap(wo)
                        let out = await ob.run(() => wo[fn](mkInst(h.mk)))
                        assert.strict.equal(out.ok, false, `${fn} should reject`)
                        chkMsg(out.err, h.msg)
                        let evErr = out.evs.filter((v) => v.t === 'error')
                        assert.strict.equal(evErr.length, 1, `${fn} should emit error exactly once`)
                        assert.strict.equal(out.nAtSettle, 1, `${fn} should emit error before reject`)
                        assert.strict.equal(evErr[0].settledAtEmit, false)
                        assert.strict.equal(evErr[0].mode, fn)
                        assert.strict.equal(evErr[0].err, out.err.message)
                        assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0)
                        assert.deepStrictEqual(await snap(wo), snapBefore)
                    })
                }
            }
        }
        it('control: a prototype getter id returning a readable non-string is treated as no id (autoGenPk true: fails at assignment, same as before)', async function() {
            let wo = mk('pid-control')
            let ob = mkObserver(wo)
            let out = await ob.run(() => wo.insert(mkInst(() => 123)))
            assert.strict.equal(out.ok, false)
            assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 1)
        })
    })
})
