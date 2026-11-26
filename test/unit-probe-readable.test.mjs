import assert from 'assert'
import fs from 'fs'
import w from 'wsemi'
import isearr from 'wsemi/src/isearr.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import cloneDeep from 'lodash-es/cloneDeep.js'
import WOrm from '../src/WOrmLevel.mjs'
import { mkObserver } from './lib/mkObserver.mjs'
import { arr1Getter, proxyOwnKeysThrows, proxyTagThrows, proxyRevoked, proxyGopdThrows, proxyProtoThrows, protoChainOwnKeysThrows, symbolOnlyGopdThrows, symbolOnlyReadable, arrLenThrows, arrRevoked } from './lib/hostile.mjs'


//呼叫端給的值之可讀性(帳本R-PROBE-01; 2026-11-20起改用wsemi之chkReadable, 刪除本地之src/probeReadable.mjs): wsemi 1.9.69起判斷函數(isestr、isbol、iseobj、isearr等)對讀取即拋錯之值
//(已撤銷之Proxy、Symbol.toStringTag或陷阱拋錯者、元素存取器拋錯之陣列等)回false而不拋錯. 規則(各案註解之[規則N]):
//  1. 站點之判斷函數回false時以chkReadable分辨[不可讀]與[可讀而型別不符], 不可讀者走該站點之原失敗通道: 寫入入口(寫入方法之data、option.returnList與經原型存取器讀出之id)與selectByPk(pk)為error事件恰一次且先於reject、
//     不發change、資料庫不變、其後之佇列照常; 建構層(opt.url、db、cl、useCache、autoGenPk)為同步throw、不建立資料夾
//  2. 訊息為固定詞彙invalid <名稱>: must be a readable value(V19), 不含原例外文字(V20): 名稱為opt、opt.url、opt.db、opt.cl、opt.useCache、opt.autoGenPk、option、option.returnList、option.autoInsert、pk、data(經原型存取器讀出之id同名稱data; 2026-11-20 oro557b2起, 原data[k].id改為data)
//  3. 可讀而型別不符者行為不變: data走輸入無效早退(n:0或[]), pk回null, returnList、useCache、autoGenPk、db、cl採忽略(預設);透明之Proxy為可讀; 僅Symbol鍵而描述子可讀之Proxy為可讀(輸入無效)
//     (wsemi 1.9.79起chkReadable之opt.ownKeys一併讀Symbol鍵之描述子: 僅Symbol鍵而getOwnPropertyDescriptor陷阱拋錯之Proxy改為不可讀, 歸規則1, 見data站點之敵意值表; 1.9.78以前只讀字串鍵之描述子而為可讀)
//  4. chkReadable不呼叫存取器: 單元素陣列之[0]存取器(isearr唯一依賴元素值之情形)由呼叫端於try內自讀; 判斷函數回true(有效輸入)時不探測, 不增加其讀取次數
//  5. 內部值(cloneDeep之複本之自有欄位、資料庫讀出值、錯誤物件之message)不探測; 惟複本保留原型, 經原型存取器讀出之id仍屬呼叫端給的值(procPk站點)
//寫入方法之data站點(insert、insertBulk、save、del)之敵意輸入案見unit-write-pre-error; 主鍵之未帶與給了而非字串見unit-pk-given
describe('probe-readable', function() {
    let url = './test/_tmp/probe-readable'

    //opened與mk: 於測試資料夾下建立資料庫, after統一關閉
    let opened = []
    let mk = (name, opt = {}) => {
        let wo = WOrm({ url: `${url}/${name}`, db: 'worm', cl: name, ...opt })
        opened.push(wo)
        return wo
    }
    //proxyEmptyArrOwnKeysThrows, 空陣列之Proxy且ownKeys陷阱拋錯(型別標籤為陣列; iseobj、isearr皆為假, 為輸入無效而非不可讀)
    let proxyEmptyArrOwnKeysThrows = () => {
        return new Proxy([], {
            ownKeys() {
                throw new Error('ownKeys-boom')
            },
        })
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

    //hostiles, 標籤不可讀之敵意值(已撤銷之Proxy、Symbol.toStringTag拋錯者、已撤銷之陣列Proxy): 純量站點(選項、pk、id)只讀標籤, 僅此類不可讀; msg為其原例外訊息(固定詞彙訊息不得含之)
    let hostiles = [
        { key: 'revoked Proxy', mk: proxyRevoked, msg: /revoked/i },
        { key: 'Proxy whose toStringTag read throws', mk: proxyTagThrows, msg: /tag-boom/ },
        { key: 'revoked array Proxy', mk: arrRevoked, msg: /revoked/i },
    ]

    //chkRd, 固定詞彙(規則2): 訊息全等於invalid <名稱>: must be a readable value, 為套件自身之Error, 且不含原例外文字
    let rdMsg = (name) => `invalid ${name}: must be a readable value`
    let chkRd = (err, name, h) => {
        assert.strict.ok(err instanceof Error, 'should throw an Error')
        assert.strict.equal(err.message, rdMsg(name))
        assert.strict.ok(!h.msg.test(err.message), 'the original exception text must not be echoed')
    }

    describe('single owner: wsemi chkReadable (the local probe module is removed)', function() {
        let dirSrc = './src'
        it('src/probeReadable.mjs does not exist; WOrmLevel.mjs imports wsemi chkReadable and no other probe [rule: one owner]', function() {
            assert.strict.equal(fs.existsSync(`${dirSrc}/probeReadable.mjs`), false)
            let code = fs.readFileSync(`${dirSrc}/WOrmLevel.mjs`, 'utf8')
            assert.strict.ok(/import chkReadable from 'wsemi\/src\/chkReadable\.mjs'/.test(code))
            assert.strict.ok(!/probeReadable|probeTag/.test(code.replace(/\/\/.*$/gm, '')), 'no local probe function is called')
        })
        it('chkReadable call sites are exactly the 8 inventoried ones (chkOptReadable for the 5 opt values, getOptVal opt container, getOpt option container, procClosed event data, chkDataReadable for the 4 data sites, procPk id, selectByPk pk, option.returnList) [rule 1]', function() {
            let code = fs.readFileSync(`${dirSrc}/WOrmLevel.mjs`, 'utf8').split('\n').filter((ln) => !/^\s*\/\//.test(ln))
            let sites = code.filter((ln) => /\bchkReadable\(/.test(ln)).map((ln) => ln.trim())
            assert.deepStrictEqual(sites, [
                'if (chkReadable(v) !== \'\') {',
                'if (chkReadable(opt) !== \'\') {',
                'if (chkReadable(option) !== \'\') {',
                'emitError(mode, chkReadable(data) === \'\' ? data : null, msg)',
                'if (chkReadable(data, { ownKeys: isobj(data), elements: \'first\' }) !== \'\') {',
                'else if (chkReadable(id) !== \'\') {',
                'if (chkReadable(pk) !== \'\') {',
                'if (chkReadable(returnList) !== \'\') {',
            ])
        })
        it('chkOptReadable is called at exactly the 5 opt sites and chkDataReadable at exactly the 4 data sites [rule 1]', function() {
            let code = fs.readFileSync(`${dirSrc}/WOrmLevel.mjs`, 'utf8').split('\n').filter((ln) => !/^\s*\/\//.test(ln)).map((ln) => ln.trim())
            assert.deepStrictEqual(code.filter((ln) => /^chkOptReadable\(/.test(ln)), [
                'chkOptReadable(\'url\', url)',
                'chkOptReadable(\'db\', db)',
                'chkOptReadable(\'cl\', cl)',
                'chkOptReadable(\'useCache\', useCache)',
                'chkOptReadable(\'autoGenPk\', autoGenPk)',
            ])
            assert.deepStrictEqual(code.filter((ln) => /^chkDataReadable\(/.test(ln)), ['chkDataReadable(data)', 'chkDataReadable(data)', 'chkDataReadable(data)', 'chkDataReadable(data)'])
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

        for (let h of hostiles) {
            it(`${h.key} as pk: rejects with the fixed message, one error event before reject, no change, database unchanged [rules 1, 2]`, async function() {
                let snapBefore = await snap(wo)
                let out = await ob.run(() => wo.selectByPk(h.mk()))
                assert.strict.equal(out.ok, false, 'selectByPk should reject')
                chkRd(out.err, 'pk', h)
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

        //可讀而型別不符(含僅在列鍵等陷阱拋錯者: 型別標籤可讀)者回null, 不發事件 [rule 3]
        let wrongTypes = [
            { key: 'number', mk: () => 123 },
            { key: 'null', mk: () => null },
            { key: 'undefined', mk: () => undefined },
            { key: 'empty string', mk: () => '' },
            { key: 'String wrapper', mk: () => new String('seed1') }, // eslint-disable-line no-new-wrappers
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

        for (let h of hostiles) {
            it(`${h.key} as returnList: rejects with the fixed message, one error event before reject (data is null: entry-stage rejection, A4), no change, database unchanged [rules 1, 2]`, async function() {
                let snapBefore = await snap(wo)
                let d = [{ id: 'rl-bad', a: 1 }]
                let out = await ob.run(() => wo.insert(d, { returnList: h.mk() }))
                assert.strict.equal(out.ok, false, 'insert should reject')
                chkRd(out.err, 'option.returnList', h)
                let evErr = out.evs.filter((v) => v.t === 'error')
                assert.strict.equal(evErr.length, 1, 'insert should emit error exactly once')
                assert.strict.equal(out.nAtSettle, 1, 'insert should emit error before reject')
                assert.strict.equal(evErr[0].settledAtEmit, false)
                assert.strict.equal(evErr[0].mode, 'insert')
                assert.strict.equal(evErr[0].err, out.err.message)
                assert.strict.ok(evErr[0].data === null, 'error event data should be null (entry-stage rejection: the unreadable value is not handed to subscribers, A4)')
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
            { key: 'Boolean wrapper', mk: () => new Boolean(true) }, // eslint-disable-line no-new-wrappers
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
            for (let h of hostiles) {
                it(`opt.${key} = ${h.key}: throws the fixed message synchronously${key === 'url' ? '' : ', creates no folder'} [rules 1, 2]`, function() {
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
                    chkRd(thrown, `opt.${key}`, h)
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
        it('Proxy whose ownKeys throws as useCache/autoGenPk (tag readable): constructs [rule 3]', async function() {
            let wo = mk('wrong-proxy', { useCache: proxyOwnKeysThrows(), autoGenPk: proxyOwnKeysThrows() })
            await wo.insert({ id: 'x1', a: 1 })
            assert.deepStrictEqual(await wo.select(), [{ id: 'x1', a: 1 }])
        })
        it('opt itself unreadable (revoked Proxy): throws the fixed container message invalid opt (A1, no longer the original error from reading opt)', function() {
            assert.strict.throws(() => WOrm(proxyRevoked()), (err) => err.message === 'invalid opt: must be a readable value')
        })
    })

    //data站點(判斷函數iseobj、isearr回false之分支): 不可讀者走原失敗通道, 訊息為固定詞彙invalid data: must be a readable value(規則1、2); 可讀而型別不符者輸入無效早退(規則3)
    describe('data site (4 write entries): unreadable data rejects with the fixed message, readable wrong-typed data is invalid input', function() {
        let entries = [
            { fn: 'insert', early: { n: 0, nInserted: 0, ok: 1 } },
            { fn: 'insertBulk', early: { n: 0, nInserted: 0, ok: 1 } },
            { fn: 'save', early: [] },
            { fn: 'del', early: [] },
        ]
        let unreadables = [
            { key: 'revoked Proxy', mk: proxyRevoked },
            { key: 'Proxy whose toStringTag read throws', mk: proxyTagThrows },
            { key: 'Proxy whose ownKeys throws', mk: proxyOwnKeysThrows },
            { key: 'Proxy whose getOwnPropertyDescriptor throws', mk: proxyGopdThrows },
            { key: 'Proxy whose getPrototypeOf throws', mk: proxyProtoThrows },
            { key: 'object whose prototype is a Proxy whose ownKeys throws', mk: protoChainOwnKeysThrows },
            { key: 'one-element array whose [0] getter throws (read by the caller inside try)', mk: arr1Getter },
            { key: 'array Proxy whose length read throws', mk: arrLenThrows },
            { key: 'revoked array Proxy', mk: arrRevoked },

            //wsemi 1.9.79起chkReadable之opt.ownKeys一併讀Symbol鍵之描述子(第559項⑤): 該Proxy之getOwnPropertyDescriptor陷阱拋錯而為不可讀(舊讀法只讀字串鍵之描述子, 曾判為可讀而早退)
            { key: 'Proxy with only Symbol keys whose getOwnPropertyDescriptor throws (chkReadable ownKeys reads Symbol-key descriptors, wsemi >= 1.9.79)', mk: symbolOnlyGopdThrows },
        ]
        let readableWrong = [
            { key: 'number 5', mk: () => 5 },
            { key: 'String wrapper', mk: () => new String('a') }, // eslint-disable-line no-new-wrappers
            { key: 'string', mk: () => 'abc' },
            { key: 'null', mk: () => null },
            { key: 'undefined', mk: () => undefined },
            { key: 'empty array', mk: () => [] },
            { key: 'empty object', mk: () => ({}) },
            { key: 'transparent Proxy with only a Symbol key (descriptor readable: counterpart of the unreadable Symbol-key Proxy above)', mk: symbolOnlyReadable },

            //標籤非[object Object]者不列鍵(iseobj之for...in唯標籤為Object時讀鍵): ownKeys陷阱拋錯之空陣列Proxy為輸入無效而非不可讀(同本地探針時之範圍), 大型二進位不配置鍵
            { key: 'empty array Proxy whose ownKeys throws (array tag: keys are never listed)', mk: proxyEmptyArrOwnKeysThrows },
            { key: 'Buffer', mk: () => Buffer.alloc(8) },
            { key: 'Uint8Array', mk: () => new Uint8Array(8) },
            { key: 'Date', mk: () => new Date(0) },
            { key: 'Map', mk: () => new Map([[1, 2]]) },
        ]
        for (let e of entries) {
            describe(e.fn, function() {
                let wo = null
                let ob = null
                before(async function() {
                    wo = mk(`data-${e.fn}`)
                    ob = mkObserver(wo)
                    await wo.insertBulk(seed())
                })
                for (let u of unreadables) {
                    it(`${u.key}: rejects with the fixed message, one error event before reject, no change, database unchanged [rules 1, 2]`, async function() {
                        let snapBefore = await snap(wo)
                        let d = u.mk()
                        let out = await ob.run(() => wo[e.fn](d))
                        assert.strict.equal(out.ok, false, `${e.fn} should reject`)
                        assert.strict.equal(out.err.message, rdMsg('data'))
                        assert.strict.ok(!/boom|revoked/i.test(out.err.message), 'the original exception text must not be echoed')
                        let evErr = out.evs.filter((v) => v.t === 'error')
                        assert.strict.equal(evErr.length, 1)
                        assert.strict.equal(out.nAtSettle, 1)
                        assert.strict.equal(evErr[0].settledAtEmit, false)
                        assert.strict.equal(evErr[0].mode, e.fn)
                        assert.strict.equal(evErr[0].err, rdMsg('data'))
                        assert.strict.ok(evErr[0].data === null, 'error event data is null (entry-stage rejection: the unreadable value is not handed to subscribers, A4)')
                        assert.strict.equal(out.evs.filter((v) => v.t === 'change').length, 0)
                        assert.deepStrictEqual(await snap(wo), snapBefore)
                        assert.deepStrictEqual(await wo.selectByPk('seed1'), { id: 'seed1', a: 1 }, 'following call should work (queue not stuck)')
                    })
                }
                for (let r of readableWrong) {
                    it(`${r.key}: readable but invalid input, early return ${JSON.stringify(e.early)}, no events [rule 3]`, async function() {
                        let out = await ob.run(() => wo[e.fn](r.mk()))
                        assert.strict.equal(out.ok, true)
                        assert.deepStrictEqual(out.val, e.early)
                        assert.strict.equal(out.evs.length, 0)
                    })
                }
            })
        }
    })

    //透明Proxy為可讀: 寫入方法照常處理(chkReadable不得多拒收) [rules 1, 3]
    describe('readable Proxy data is not rejected', function() {
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
        it('insert: a transparent Proxy with only a Symbol key (descriptor readable) is readable: invalid input, early return n:0, no events [rule 3]', async function() {
            let wo = mk('proxy-symbol-only')
            let ob = mkObserver(wo)
            let out = await ob.run(() => wo.insert(symbolOnlyReadable()))
            assert.strict.equal(out.ok, true)
            assert.deepStrictEqual(out.val, { n: 0, nInserted: 0, ok: 1 })
            assert.strict.equal(out.evs.length, 0)
        })
    })

    //有效輸入不探測(規則4): 判斷函數回true者之讀取次數同修前(判定一次＋cloneDeep), 不得多讀一次(有狀態之存取器不被多執行)
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

    //有效之物件Proxy: 其ownKeys陷阱之呼叫次數同iseobj + cloneDeep(修前基準), 檢測不得多列一次鍵; 標籤非Object之無效輸入(空陣列Proxy)之ownKeys陷阱呼叫次數為0
    describe('valid object Proxy data: ownKeys trap is called as often as iseobj + cloneDeep; invalid array-tag Proxy never lists keys', function() {
        let mkCountProxy = (target) => {
            let c = { n: 0 }
            let p = new Proxy(target, {
                ownKeys(t) {
                    c.n++
                    return Reflect.ownKeys(t)
                },
            })
            return { p, c }
        }
        let base = mkCountProxy({ id: 'b0', a: 1 })
        iseobj(base.p)
        cloneDeep(base.p)
        for (let fn of ['insert', 'insertBulk', 'save', 'del']) {
            it(`${fn}: valid object Proxy data lists keys exactly as often as iseobj + cloneDeep (${base.c.n}) [rule 4]`, async function() {
                let wo = mk(`okeys-${fn}`)
                let t = mkCountProxy({ id: `o-${fn}`, a: 1 })
                await wo[fn](t.p)
                assert.strict.equal(t.c.n, base.c.n)
            })
            it(`${fn}: invalid empty array Proxy: its ownKeys trap is never called (the array tag does not list keys) [rule 3]`, async function() {
                let wo = mk(`okeys-empty-${fn}`)
                let t = mkCountProxy([])
                await wo[fn](t.p)
                assert.strict.equal(t.c.n, 0)
            })
        }
    })

    //id經原型存取器讀出(規則5): cloneDeep保留原型, 類別實例原型上之id存取器於複本上仍執行呼叫端之程式(照既有路徑取值1次, 拋錯者走錯誤路徑, 固定詞彙invalid data: must be a readable value, 見unit-align-readable A2);
    //2026-11-20(第569項olv569, 帳本R-PKOWN-01)起: 該id屬繼承而非自有可列舉, 視為「未帶」, 其回傳之值(不論標籤是否可讀)不被探測、不被使用——
    //autoGenPk為true補新主鍵(複本之id為自有資料屬性, 不經賦值), 為false依「未帶」整批reject(訊息can not <入口> by data[0] without valid id when autoGenPk is false);
    //修前此處為「標籤不可讀者拒絕為invalid data」, 與「可讀而非字串者拒絕為not a string」(見unit-pk-given): 兩者皆因把繼承值當主鍵而生
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
                for (let h of hostiles) {
                    if (apk) {
                        it(`${fn} (autoGenPk true): prototype getter id returns ${h.key}: an inherited id is not given, its value is neither probed nor used, a generated id is stored, no error event [rules 1, 2, 5; R-PKOWN-01]`, async function() {
                            let wo = mk(`pid-${fn}-${apk}-${h.key.replace(/\W+/g, '_')}`, { autoGenPk: apk })
                            let ob = mkObserver(wo)
                            await wo.insertBulk(seed())
                            let snapBefore = await snap(wo)
                            let out = await ob.run(() => wo[fn](mkInst(h.mk)))
                            assert.strict.equal(out.ok, true, `${fn} should resolve, got ${out.err && out.err.message}`)
                            assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0)
                            assert.strict.equal(out.evs.filter((v) => v.t === 'change' && v.mode === fn).length, 1)
                            let after = await snap(wo)
                            assert.strict.equal(after.length, snapBefore.length + 1)
                            let added = after.filter((v) => !snapBefore.some((x) => x.id === v.id))
                            assert.strict.equal(added.length, 1)
                            assert.strict.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(added[0].id), `generated id expected, got ${String(added[0].id)}`)
                        })
                    }
                    else {
                        it(`${fn} (autoGenPk false): prototype getter id returns ${h.key}: an inherited id is not given, rejected as not given (whole batch), one error event before reject, no change, database unchanged [rules 1, 2, 5; R-PKOWN-01]`, async function() {
                            let wo = mk(`pid-${fn}-${apk}-${h.key.replace(/\W+/g, '_')}`, { autoGenPk: apk })
                            let ob = mkObserver(wo)
                            await wo.insertBulk(seed())
                            let snapBefore = await snap(wo)
                            let out = await ob.run(() => wo[fn](mkInst(h.mk)))
                            assert.strict.equal(out.ok, false, `${fn} should reject`)
                            assert.strict.equal(out.err.message, `can not ${fn} by data[0] without valid id when autoGenPk is false`)
                            assert.strict.ok(!h.msg.test(out.err.message), 'the hostile value must not be echoed')
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
        }
        it('control: a prototype getter id returning a readable non-string is an inherited id too: not given, a generated id is stored (see unit-pk-own)', async function() {
            let wo = mk('pid-control')
            let ob = mkObserver(wo)
            let out = await ob.run(() => wo.insert(mkInst(() => 123)))
            assert.strict.equal(out.ok, true)
            assert.deepStrictEqual(out.val, { n: 1, nInserted: 1, ok: 1 })
            assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0)
        })
    })
})
