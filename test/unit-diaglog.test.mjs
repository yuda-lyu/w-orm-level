import assert from 'assert'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'
import { inspect } from 'util'
import { getOptLog, getSecrets, maskText, cpMask, mkTypes, TYPES, getDiag, getBriefErr } from '../src/getDiag.mjs'
import { capture, tick } from './tools/diagCapture.mjs'


//診斷輸出(帳本R-DIAG-01)之單元測試: getOptLog、getDiag、getSecrets/cpMask、getBriefErr與單一出口掃描
//規則: ①src內除getDiag.mjs外不得直接輸出; ②預設只輸出標籤與不含個資之摘要; ③opt.logDetail還原細節、opt.funLog(label, safe, detail)取代console, 型別錯誤用預設;
//④回傳契約不變(見api-diaglog); ⑤位址名稱視同連線字串, 於細節(logDetail與funLog)遮罩(見api-diaglog); ⑥診斷輸出自身不拋錯且不執行使用端getter


//FB, 不依賴util.types之退回判定(非Node或舊版Node的行為), 與預設TYPES(取自Node的util.types)並行測試
const FB = mkTypes(null)


describe('diaglog: getOptLog(規則③)', function() {

    it('未給、null、空物件為預設{ logDetail: false, funLog: null }', function() {
        for (let opt of [undefined, null, {}, 'x', 123]) {
            assert.deepStrictEqual(getOptLog(opt), { logDetail: false, funLog: null })
        }
    })

    it('logDetail須嚴格為true才生效, 型別錯誤者用預設(同useCache、autoGenPk)', function() {
        assert.strictEqual(getOptLog({ logDetail: true }).logDetail, true)
        for (let v of ['true', 1, {}, [], null, undefined, 'false', 0, () => true]) {
            assert.strictEqual(getOptLog({ logDetail: v }).logDetail, false)
        }
        assert.strictEqual(getOptLog({ logDetail: false }).logDetail, false)
    })

    it('funLog須為函數才生效, 型別錯誤者用預設', function() {
        let f = () => {}
        assert.strictEqual(getOptLog({ funLog: f }).funLog, f)
        for (let v of ['x', 1, {}, [], null, undefined, true]) {
            assert.strictEqual(getOptLog({ funLog: v }).funLog, null)
        }
    })

    it('讀取選項拋錯者忽略, 單一getter拋錯只丟該選項', function() {
        let f = () => {}
        let r1 = getOptLog({
            get logDetail() {
                throw new Error('x')
            },
            funLog: f,
        })
        assert.deepStrictEqual(r1, { logDetail: false, funLog: f })
        let r2 = getOptLog({
            logDetail: true,
            get funLog() {
                throw new Error('x')
            },
        })
        assert.deepStrictEqual(r2, { logDetail: true, funLog: null })
    })

    it('回傳為固定快照, 其後使用端改動opt不影響已建立之diag', async function() {
        let logs = []
        let opt = { funLog: (label) => logs.push(label) }
        let diag = getDiag(getOptLog(opt))
        opt.funLog = null
        opt.logDetail = true
        let r = await capture(() => diag('t1', { a: 1 }))
        assert.deepStrictEqual(logs, ['t1'])
        assert.strictEqual(r.calls.length, 0)
    })

})


describe('diaglog: getDiag(規則②③⑥)', function() {

    it('預設: console.log(label, safe), 不呼叫getDetail', async function() {
        let n = 0
        let diag = getDiag(getOptLog({}))
        let r = await capture(() => {
            diag('lab', { mode: 'insert', errType: 'Error' }, () => {
                n++
                return 'DETAIL'
            }, true)
        })
        assert.strictEqual(n, 0)
        assert.deepStrictEqual(r.calls, [{ fn: 'console.log', args: ['lab', { mode: 'insert', errType: 'Error' }] }])
    })

    it('預設且無safe: console.log(label)', async function() {
        let diag = getDiag(getOptLog({}))
        let r = await capture(() => diag('lab'))
        assert.deepStrictEqual(r.calls, [{ fn: 'console.log', args: ['lab'] }])
    })

    it('optLog未給、null、未經getOptLog包裝之物件皆正規化(欄位缺漏不使輸出消失)', async function() {
        let r1 = await capture(() => getDiag()('lab', { a: 1 }, () => 'DETAIL'))
        assert.deepStrictEqual(r1.calls, [{ fn: 'console.log', args: ['lab', { a: 1 }] }])
        let r2 = await capture(() => getDiag(null)('lab', { a: 1 }))
        assert.deepStrictEqual(r2.calls, [{ fn: 'console.log', args: ['lab', { a: 1 }] }])
        let r3 = await capture(() => getDiag({})('lab', { a: 1 }))
        assert.deepStrictEqual(r3.calls, [{ fn: 'console.log', args: ['lab', { a: 1 }] }])
        let r4 = await capture(() => getDiag({ logDetail: true })('lab', { a: 1 }, () => 'DETAIL', true))
        assert.deepStrictEqual(r4.calls, [{ fn: 'console.log', args: ['DETAIL'] }])
        let got = []
        let r5 = await capture(() => getDiag({ funLog: (...args) => got.push(args) })('lab', { a: 1 }, () => 'DETAIL'))
        assert.strictEqual(r5.calls.length, 0)
        assert.deepStrictEqual(got, [['lab', { a: 1 }, 'DETAIL']])
    })

    it('logDetail: 非bare為console.log(label, 細節); bare為console.log(細節)(舊版輸出格式)', async function() {
        let diag = getDiag(getOptLog({ logDetail: true }))
        let r = await capture(() => {
            diag('lab', { a: 1 }, () => 'DETAIL')
            diag('lab', { a: 1 }, () => 'DETAIL', true)
            diag('lab', { a: 1 })
            diag('lab', { a: 1 }, undefined, true)
        })
        assert.deepStrictEqual(r.calls.map((c) => c.args), [['lab', 'DETAIL'], ['DETAIL'], ['lab'], []])
    })

    it('funLog: 收(label, safe, detail), 不寫console; 無細節者只收兩個引數', async function() {
        let got = []
        let diag = getDiag(getOptLog({ funLog: (...args) => got.push(args) }))
        let d = { x: 1 }
        let r = await capture(() => {
            diag('lab', { a: 1 }, () => d, true)
            diag('lab2', { a: 2 })
        })
        assert.strictEqual(r.calls.length, 0)
        assert.strictEqual(got.length, 2)
        assert.strictEqual(got[0].length, 3)
        assert.deepStrictEqual(got[0].slice(0, 2), ['lab', { a: 1 }])
        assert.deepStrictEqual(got[1], ['lab2', { a: 2 }])

        //detail為拷貝而非原參照: 結構相同、原型為內建、funLog原地修改不影響原物件
        assert.deepStrictEqual(got[0][2], { x: 1 })
        assert.notStrictEqual(got[0][2], d)
        got[0][2].x = '***'
        assert.deepStrictEqual(d, { x: 1 })
    })

    it('funLog優先於logDetail(給予時診斷輸出只交給它)', async function() {
        let got = []
        let diag = getDiag(getOptLog({ logDetail: true, funLog: (...args) => got.push(args) }))
        let r = await capture(() => diag('lab', { a: 1 }, () => 'DETAIL'))
        assert.strictEqual(r.calls.length, 0)
        assert.deepStrictEqual(got, [['lab', { a: 1 }, 'DETAIL']])
    })

    it('funLog同步拋錯: 吞下, 不寫console, diag不拋錯', async function() {
        let diag = getDiag(getOptLog({
            funLog: () => {
                throw new Error('boom')
            },
        }))
        let r = await capture(() => diag('lab', { a: 1 }, () => 'DETAIL'))
        assert.strictEqual(r.calls.length, 0)
    })

    it('funLog回傳reject之promise或會拋錯之thenable: 不成為unhandledRejection、不拋錯(含自有then被覆寫之原生promise, thenable之then只讀一次)', async function() {
        let un = []
        let onUn = (e) => un.push(e)
        process.on('unhandledRejection', onUn)
        try {
            let pOwn = Promise.reject(new Error('rej own'))
            Object.defineProperty(pOwn, 'then', { value: null })
            let nThen = 0
            let nThen2 = 0
            let fs_ = [
                () => Promise.reject(new Error('rej')),
                () => pOwn,
                () => ({
                    then() {
                        return Promise.reject(new Error('rej2'))
                    },
                }),
                () => ({
                    get then() {
                        throw new Error('getter')
                    },
                }),
                async() => {
                    throw new Error('async')
                },
                () => ({
                    then() {
                        let p = Promise.reject(new Error('rej3'))
                        return {
                            get then() {
                                nThen2++
                                return p.then.bind(p)
                            },
                        }
                    },
                }),
                () => ({
                    get then() {
                        nThen++
                        return () => {}
                    },
                }),
            ]
            let r = await capture(async() => {
                for (let f of fs_) {
                    getDiag(getOptLog({ funLog: f }))('lab')
                }
                await tick()
                await tick()
            })
            assert.strictEqual(r.calls.length, 0)
            await tick()
            assert.strictEqual(un.length, 0)
            assert.strictEqual(nThen, 1)
            assert.strictEqual(nThen2, 1)
        }
        finally {
            process.removeListener('unhandledRejection', onUn)
        }
    })

    it('不依賴util.types之退回判定(FB)亦吞下reject之promise', async function() {
        let un = []
        let onUn = (e) => un.push(e)
        process.on('unhandledRejection', onUn)
        try {
            await capture(async() => {
                getDiag(getOptLog({ funLog: () => Promise.reject(new Error('rej')) }), [], FB)('lab')
                getDiag(getOptLog({
                    funLog: async() => {
                        throw new Error('x')
                    }
                }), [], FB)('lab')
                await tick()
                await tick()
            })
            assert.strictEqual(un.length, 0)
        }
        finally {
            process.removeListener('unhandledRejection', onUn)
        }
    })

    it('getDetail拋錯: 預設不呼叫故無影響; logDetail與funLog以(unprintable)代替', async function() {
        let bad = () => {
            throw new Error('detail boom')
        }
        let d0 = getDiag(getOptLog({}))
        let d1 = getDiag(getOptLog({ logDetail: true }))
        let got = []
        let d2 = getDiag(getOptLog({ funLog: (...args) => got.push(args) }))
        let r = await capture(() => {
            d0('lab', { a: 1 }, bad)
            d1('lab', { a: 1 }, bad)
            d2('lab', { a: 1 }, bad)
        })
        assert.deepStrictEqual(r.calls.map((c) => c.args), [['lab', { a: 1 }], ['lab', '(unprintable)']])
        assert.deepStrictEqual(got, [['lab', { a: 1 }, '(unprintable)']])
    })

    it('console.log拋錯: 改輸出(label, (unprintable)), 再拋則放棄, diag不拋錯', async function() {
        let diag = getDiag(getOptLog({ logDetail: true }))
        let orgLog = console.log

        //第一次console.log拋錯(模擬格式化失敗), 第二次(label, '(unprintable)')成功: 後備輸出須精確為[label, '(unprintable)']
        let calls = []
        let n = 0
        console.log = (...args) => {
            n++
            if (n === 1) {
                throw new Error('format boom')
            }
            calls.push(args)
        }
        try {
            diag('lab', { a: 1 }, () => 'DETAIL', true)
        }
        finally {
            console.log = orgLog
        }
        assert.deepStrictEqual(calls, [['lab', '(unprintable)']])

        //console.log一律拋錯: 放棄輸出
        n = 0
        console.log = () => {
            n++
            throw new Error('console down')
        }
        try {
            diag('lab', { a: 1 }, () => 'x')
            getDiag(getOptLog({}))('lab', { a: 1 })
        }
        finally {
            console.log = orgLog
        }
        assert.strictEqual(n, 4)
    })

    it('細節含函數(如inspect.custom拋錯者)經拷貝後不再於console.log格式化時執行', async function() {
        let odd = {
            [inspect.custom]() {
                throw new Error('inspect boom')
            },
            a: 1,
        }
        let diag = getDiag(getOptLog({ logDetail: true }))
        let outs = []
        let orgLog = console.log
        console.log = (...args) => {
            outs.push(inspect(args))
        }
        try {
            diag('lab', { a: 1 }, () => odd, true)
        }
        finally {
            console.log = orgLog
        }
        assert.strictEqual(outs.length, 1)
        assert.ok(outs[0].includes('a: 1'))
        assert.ok(!outs[0].includes('unprintable'))
    })

})


describe('diaglog: getSecrets、maskText與cpMask(規則⑤)', function() {

    it('getSecrets: 儲存位址與url之原樣、反斜線形式、絕對路徑形式; db與cl單獨、過短或全為路徑符號之url不列入; 長者在前', function() {
        let cwd = process.cwd().replace(/\\/g, '/')
        let s = getSecrets('./_db', 'worm', 'test')
        assert.ok(s.includes('./_db/worm/test'))
        assert.ok(s.includes('.\\_db\\worm\\test'))
        assert.ok(s.includes('./_db'))
        assert.ok(s.includes(`${cwd}/_db/worm/test`))
        assert.ok(s.includes(`${cwd}/_db/worm/test`.replace(/\//g, '\\')))
        assert.ok(s.includes(`${cwd}/_db`))
        assert.ok(!s.includes('worm') && !s.includes('test'))
        for (let k = 1; k < s.length; k++) {
            assert.ok(s[k - 1].length >= s[k].length)
        }

        //url過短或全為路徑符號者不單獨列入(否則會吞掉大量無關文字), 儲存位址仍列入
        let s2 = getSecrets('.', 'worm', 'test')
        assert.ok(s2.includes('./worm/test'))
        assert.ok(!s2.includes('.'))
        let s3 = getSecrets('./', 'a', 'b')
        assert.ok(!s3.includes('./') && !s3.includes('.'))

        //絕對路徑之url不再加cwd
        let abs = getSecrets('C:/data/x', 'worm', 'test')
        assert.ok(abs.includes('C:/data/x/worm/test') && abs.includes('C:\\data\\x\\worm\\test') && abs.includes('C:/data/x'))
        assert.ok(!abs.some((v) => v.includes(cwd)))

        //上層目錄段解析
        let up = getSecrets('../up', 'worm', 'test')
        let parent = cwd.split('/').slice(0, -1).join('/')
        assert.ok(up.includes(`${parent}/up/worm/test`))
    })

    it('maskText: 清單項目以***取代(多處、多項), 非字串原樣', function() {
        assert.strictEqual(maskText('x ./a/b/c y ./a/b/c z', ['./a/b/c']), 'x *** y *** z')
        assert.strictEqual(maskText('p ./a/b/c/000005.ldb', ['./a/b/c', './a']), 'p ***/000005.ldb')
        assert.strictEqual(maskText('nothing', ['./a/b/c']), 'nothing')
        assert.strictEqual(maskText(123, ['1']), 123)
        assert.strictEqual(maskText('abc', []), 'abc')
    })

    it('cpMask: 值、屬性鍵、Symbol描述、陣列元素、Error之message/stack/cause/name皆遮罩, 不改動原物件, 非原參照', function() {
        let S = ['./_db/worm/test']
        let sym = Symbol('key ./_db/worm/test')
        let e = new Error('IO error: ./_db/worm/test/000005.ldb', { cause: new TypeError('inner ./_db/worm/test') })
        e.code = 'ERR_X'
        e.extra = { path: './_db/worm/test', list: ['./_db/worm/test', 'ok', 7, true, null, undefined] }
        e['./_db/worm/test'] = 'k'
        e[sym] = 'sv ./_db/worm/test'
        let before = inspect(e, { depth: 5, showHidden: true })
        let r = cpMask(e, S)
        assert.notStrictEqual(r, e)
        assert.ok(r instanceof Error)
        assert.strictEqual(r.message, 'IO error: ***/000005.ldb')
        assert.ok(r.stack.startsWith('Error: IO error: ***/000005.ldb'))
        assert.ok(!r.stack.includes('_db/worm/test'))
        assert.strictEqual(r.name, 'Error')
        assert.strictEqual(r.code, 'ERR_X')
        assert.strictEqual(r.cause.message, 'inner ***')
        assert.deepStrictEqual(r.extra, { path: '***', list: ['***', 'ok', 7, true, null, undefined] })
        assert.strictEqual(r['***'], 'k')
        assert.strictEqual(Object.getOwnPropertySymbols(r).length, 1)
        let rs = Object.getOwnPropertySymbols(r)[0]
        assert.strictEqual(rs.description, 'key ***')
        assert.strictEqual(r[rs], 'sv ***')
        assert.ok(!inspect(r, { depth: 6, showHidden: true }).includes('_db/worm/test'))
        assert.strictEqual(inspect(e, { depth: 5, showHidden: true }), before)
    })

    it('cpMask: 頂層字串遮罩; 純量與null原樣; 類別名稱(原型上之name)保留', function() {
        assert.strictEqual(cpMask('a ./x/y/z b', ['./x/y/z']), 'a *** b')
        for (let v of [1, true, null, undefined, 10n]) {
            assert.strictEqual(cpMask(v, ['abc']), v)
        }
        class NamedError extends Error {}
        NamedError.prototype.name = 'NamedError'
        let r = cpMask(new NamedError('m ./x/y/z'), ['./x/y/z'])
        assert.strictEqual(r.name, 'NamedError')
        assert.strictEqual(r.message, 'm ***')
        assert.ok(r.stack.startsWith('NamedError: m ***'))

        //類別名稱在深層祖先之原型上(拷貝的name須沿原型鏈取到第一個資料屬性, 不只一兩層)
        class A extends Error {}
        A.prototype.name = 'DeepName'
        class B extends A {}
        class C extends B {}
        class D extends C {}
        assert.strictEqual(cpMask(new D('x'), []).name, 'DeepName')
    })

    it('cpMask: 不執行使用端程式(存取器、方法、建構子), 存取器以標記代替; 不沿用原型(繼承屬性與inspect.custom不外帶)', function() {
        let n = 0
        let o = {
            get g() {
                n++
                return 'g'
            },
            fn() {
                n++
            },
            plain: 1,
        }
        let proto = {
            inherited: 'from-proto',
            [inspect.custom]() {
                n++
                return 'custom'
            },
        }
        let inst = Object.create(proto)
        inst.own = 'o'
        let r = cpMask({ o, inst }, [])
        assert.strictEqual(n, 0)
        assert.deepStrictEqual(r, { o: { g: '[Getter/Setter]', fn: '[Function]', plain: 1 }, inst: { own: 'o' } })
        assert.strictEqual(Object.getPrototypeOf(r.inst), Object.prototype)
        assert.ok(!inspect(r).includes('custom'))
    })

    it('cpMask: 循環參照、深度與節點上限、Date、二進位、Map與Set、稀疏陣列', function() {
        let a = { name: 'a' }
        a.self = a
        let r1 = cpMask(a, [])
        assert.strictEqual(r1.self, r1)
        assert.notStrictEqual(r1, a)

        //深度: 第8層起以標記代替
        let deep = { v: 0 }
        let cur = deep
        for (let i = 1; i < 12; i++) {
            cur.next = { v: i }
            cur = cur.next
        }
        let r2 = cpMask(deep, [])
        let depthSeen = 0
        for (let x = r2; typeof x === 'object' && x !== null; x = x.next) {
            depthSeen++
        }
        assert.strictEqual(depthSeen, 8)
        assert.ok(inspect(r2, { depth: 20 }).includes('[Truncated]'))

        //節點上限: 巨大陣列不被完整複製
        let big = new Array(20000).fill(0).map((v, k) => ({ k }))
        let r3 = cpMask(big, [])
        assert.strictEqual(r3.length, 20000)
        assert.ok(Object.keys(r3).length < 20000)
        assert.ok(Object.keys(r3).length > 1000)

        let d = new Date('2026-01-02T03:04:05.678Z')
        let sparse = [1]
        sparse[2] = 3
        let r4 = cpMask({ d, buf: Buffer.from('abc'), u8: new Uint8Array(4), ab: new ArrayBuffer(8), m: new Map([['a', 1]]), s: new Set([1]), re: /x/, sparse }, [])
        assert.ok(r4.d instanceof Date && r4.d !== d && r4.d.getTime() === d.getTime())
        assert.strictEqual(r4.buf, '[Binary 3 bytes]')
        assert.strictEqual(r4.u8, '[Binary 4 bytes]')
        assert.strictEqual(r4.ab, '[Binary 8 bytes]')
        assert.strictEqual(r4.m, '[Object]')
        assert.strictEqual(r4.s, '[Object]')
        assert.strictEqual(r4.re, '[Object]')
        assert.strictEqual(r4.sparse.length, 3)
        assert.ok(!(1 in r4.sparse))
    })

    it('cpMask: Proxy以標記代替且不觸發trap(有util.types時); 退回判定下trap拋錯亦不外傳', function() {
        let traps = []
        let p = new Proxy({ a: 1 }, {
            ownKeys(t) {
                traps.push('ownKeys')
                return Reflect.ownKeys(t)
            },
            getPrototypeOf(t) {
                traps.push('getPrototypeOf')
                return Reflect.getPrototypeOf(t)
            },
            getOwnPropertyDescriptor(t, k) {
                traps.push('gopd')
                return Reflect.getOwnPropertyDescriptor(t, k)
            },
        })
        if (TYPES.isProxy(p)) {
            assert.strictEqual(cpMask({ p }, []).p, '[Proxy]')
            assert.deepStrictEqual(traps, [])
        }
        assert.strictEqual(cpMask({ p }, [], mkTypes({ isProxy: (v) => v === p })).p, '[Proxy]')
        let bad = new Proxy({}, {
            ownKeys() {
                throw new Error('trap')
            },
        })
        let r = cpMask({ bad }, [], FB)
        assert.strictEqual(r.bad, '[Uncopyable]')
    })

})


describe('diaglog: getBriefErr(規則②⑥)', function() {

    class MyError extends Error {}

    it('非物件值: 只列型別, 不含值', function() {
        assert.deepStrictEqual(getBriefErr('secret-text'), { errType: 'string' })
        assert.deepStrictEqual(getBriefErr(''), { errType: 'string' })
        assert.deepStrictEqual(getBriefErr(null), { errType: 'null' })
        assert.deepStrictEqual(getBriefErr(undefined), { errType: 'undefined' })
        assert.deepStrictEqual(getBriefErr(42), { errType: 'number' })
        assert.deepStrictEqual(getBriefErr(true), { errType: 'boolean' })
        assert.deepStrictEqual(getBriefErr(10n), { errType: 'bigint' })
        assert.deepStrictEqual(getBriefErr(Symbol('secret')), { errType: 'symbol' })
        assert.deepStrictEqual(getBriefErr(() => {}), { errType: 'function' })
        assert.deepStrictEqual(getBriefErr({ message: 'secret' }), { errType: 'object' })
        assert.deepStrictEqual(getBriefErr([1, 2]), { errType: 'object' })
    })

    it('Error: 列建構子名稱, 不含message與stack', function() {
        assert.deepStrictEqual(getBriefErr(new Error('secret-msg')), { errType: 'Error' })
        assert.deepStrictEqual(getBriefErr(new TypeError('secret-msg')), { errType: 'TypeError' })
        assert.deepStrictEqual(getBriefErr(new MyError('secret-msg')), { errType: 'MyError' })
        let s = JSON.stringify([getBriefErr(new Error('secret-msg')), getBriefErr(new MyError('secret-msg'))])
        assert.ok(!s.includes('secret'))
    })

    it('建構子名稱沿原型鏈取第一個資料屬性constructor(多層繼承、實例自有constructor)', function() {
        class A extends Error {}
        class B extends A {}
        class C extends B {}
        assert.deepStrictEqual(getBriefErr(new C('x')), { errType: 'C' })
        assert.deepStrictEqual(getBriefErr(new B('x')), { errType: 'B' })
        let e = new Error('x')
        Object.defineProperty(e, 'constructor', { value: function OwnCtor() {}, configurable: true })
        assert.deepStrictEqual(getBriefErr(e), { errType: 'OwnCtor' })

        //TypeError之子類別名稱取子類別, 不取祖先
        class SubTypeError extends TypeError {}
        assert.deepStrictEqual(getBriefErr(new SubTypeError('x')), { errType: 'SubTypeError' })

        //constructor在原型鏈更深處(實例與前兩層原型皆無自有constructor): 須沿原型鏈取到
        class DeepErr extends Error {}
        let deep = new Error('x')
        Object.setPrototypeOf(deep, Object.create(Object.create(Object.create(DeepErr.prototype))))
        assert.deepStrictEqual(getBriefErr(deep), { errType: 'DeepErr' })
    })

    it('建構子名稱不合識別字樣式(含空白、符號、連字號、過長)者列為Error', function() {
        for (let nm of ['bad name', 'u-secret-001@example.com', 'u-secret-001', 'a-b', '1abc', '', 'x'.repeat(41), 'a.b', '_Internal', '$Dollar']) {
            let C = class extends Error {}
            Object.defineProperty(C, 'name', { value: nm })
            assert.deepStrictEqual(getBriefErr(new C('x')), { errType: 'Error' }, nm)
        }
        let C2 = class extends Error {}
        Object.defineProperty(C2, 'name', { value: 'x'.repeat(40) })
        assert.deepStrictEqual(getBriefErr(new C2('x')), { errType: 'x'.repeat(40) })
    })

    it('代碼: 只放行機器代碼樣式(ENOENT類、E2BIG、ERR_、LEVEL_、絕對值至99999之整數)', function() {
        let mk = (code) => Object.assign(new Error('x'), { code })
        for (let c of ['ENOENT', 'EACCES', 'ECONNRESET', 'E2BIG', 'ERR_INVALID_ARG_TYPE', 'LEVEL_DATABASE_NOT_OPEN', 'LEVEL_NOT_FOUND', 0, 1, 99999, -99999, 4060]) {
            assert.deepStrictEqual(getBriefErr(mk(c)), { errType: 'Error', errCode: c }, String(c))
        }
        for (let c of ['u-secret-001@example.com', 'alice', 'Alice123', 'ABCDE', 'E1', 'E123456789', 'EMP00123', 'E2BIGX', 'ERR_', 'LEVEL_', 'level_x', 100000, -100000, 1.5, NaN, Infinity, null, undefined, {}, [], true, 'ENOENT secret', 'ENOENT\nsecret']) {
            assert.deepStrictEqual(getBriefErr(mk(c)), { errType: 'Error' }, String(c))
        }
        assert.deepStrictEqual(getBriefErr({ code: 'ERR_X' }), { errType: 'object', errCode: 'ERR_X' })
    })

    it('不執行使用端getter(code、name、message、constructor、toString、Symbol.toStringTag、stack), 繼承之code不採用', function() {
        let n = 0
        let hit = () => {
            n++
            return 'ERR_GETTER'
        }
        let e = new Error('x')
        for (let k of ['code', 'name', 'message', 'toString', 'cause', Symbol.toStringTag]) {
            Object.defineProperty(e, k, { get: hit, configurable: true })
        }
        Object.defineProperty(e, 'stack', { get: hit, configurable: true })
        assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' })
        let o = {}
        for (let k of ['code', 'name', 'message', 'toString', 'constructor', Symbol.toStringTag]) {
            Object.defineProperty(o, k, { get: hit, configurable: true })
        }
        assert.deepStrictEqual(getBriefErr(o), { errType: 'object' })
        assert.strictEqual(n, 0)

        //繼承之code(原型上)不採用
        let proto = { code: 'ERR_INHERIT' }
        let child = Object.create(proto)
        assert.deepStrictEqual(getBriefErr(child), { errType: 'object' })
    })

    it('自有屬性遮蔽原型: constructor為存取器或非函數值時以遮蔽層為準(列Error), 不越層取祖先; 建構子之name為存取器亦不執行', function() {
        let n = 0
        let hit = () => {
            n++
            return 'X'
        }
        class SubTypeError extends TypeError {}
        Object.defineProperty(SubTypeError.prototype, 'constructor', { get: hit, configurable: true })
        assert.deepStrictEqual(getBriefErr(new SubTypeError('x')), { errType: 'Error' })
        let e = new TypeError('secret')
        Object.defineProperty(e, 'constructor', { value: null, configurable: true })
        assert.deepStrictEqual(getBriefErr(e), { errType: 'Error' })
        class ParentErr extends Error {}
        class ChildErr extends ParentErr {}
        Object.defineProperty(ChildErr, 'name', { get: hit, configurable: true })
        assert.deepStrictEqual(getBriefErr(new ChildErr('x')), { errType: 'Error' })
        assert.strictEqual(n, 0)
    })

    it('Proxy: 有util.types時只列Proxy且不觸發任何trap; 退回判定下trap拋錯或循環getPrototypeOf亦不拋錯、不無窮迴圈', function() {
        let traps = []
        let handler = {}
        for (let k of ['get', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'has', 'ownKeys']) {
            handler[k] = (t, ...rest) => {
                traps.push(k)
                return Reflect[k](t, ...rest)
            }
        }
        let p = new Proxy(new Error('secret'), handler)
        if (TYPES.isProxy(p)) {
            assert.deepStrictEqual(getBriefErr(p), { errType: 'Proxy' })
            assert.deepStrictEqual(traps, [])
        }
        assert.deepStrictEqual(getBriefErr(p, mkTypes({ isProxy: () => true })), { errType: 'Proxy' })

        //退回判定(FB): trap拋錯
        let bad = new Proxy({}, {
            get() {
                throw new Error('trap get')
            },
            getPrototypeOf() {
                throw new Error('trap proto')
            },
            getOwnPropertyDescriptor() {
                throw new Error('trap desc')
            },
        })
        let r = getBriefErr(bad, FB)
        assert.ok(r.errType === 'unknown' || r.errType === 'object')
        assert.ok(!JSON.stringify(r).includes('trap'))
        assert.ok(!JSON.stringify(getBriefErr(new Proxy(new Error('secret'), {}), FB)).includes('secret'))

        //退回判定(FB): getPrototypeOf首次回Error.prototype(通過instanceof)、其後回自身, 原型鏈走訪須有層數上限
        let n = 0
        let cyc = new Proxy(new Error('secret'), {
            getPrototypeOf() {
                return n++ === 0 ? Error.prototype : cyc
            },
        })
        let rc = getBriefErr(cyc, FB)
        assert.ok(typeof rc.errType === 'string')
        assert.ok(n >= 1)
    })

    it('null原型物件與跨realm之Error不拋錯且不含訊息: 有util.types時跨realm之Error認得(列其建構子名稱), 退回判定下列object', function() {
        let o = Object.create(null)
        o.message = 'secret'
        o.code = 'ERR_X'
        assert.deepStrictEqual(getBriefErr(o), { errType: 'object', errCode: 'ERR_X' })
        let ex = vm.runInNewContext('new Error("secret-cross")')
        let r = getBriefErr(ex)
        assert.ok(!JSON.stringify(r).includes('secret'))
        if (TYPES.isNativeError(ex)) {
            assert.ok(!(ex instanceof Error))
            assert.deepStrictEqual(r, { errType: 'Error' })
        }
        let rf = getBriefErr(ex, FB)
        assert.deepStrictEqual(rf, { errType: 'object' })
    })

})


describe('diaglog: 單一出口掃描(規則①)', function() {
    let dirSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

    //strip, 移除區塊註解與行註解(//前須為行首或空白, 以免誤砍字串內之網址)
    let strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((ln) => ln.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')

    let files = fs.readdirSync(dirSrc).filter((fn) => fn.endsWith('.mjs') || fn.endsWith('.js'))

    it('src內有getDiag.mjs與WOrmLevel.mjs', function() {
        assert.ok(files.includes('getDiag.mjs'))
        assert.ok(files.includes('WOrmLevel.mjs'))
    })

    it('除getDiag.mjs外, src不得出現console、process、stdout、stderr、emitWarning、globalThis、global、require、動態import之實際用法(註解不計; 含console?.log、別名與括號存取)', function() {
        let bad = []
        for (let fn of files) {
            if (fn === 'getDiag.mjs') {
                continue
            }
            let code = strip(fs.readFileSync(path.join(dirSrc, fn), 'utf8'))
            for (let re of [/\bconsole\b/, /\bprocess\b/, /\bstdout\b/, /\bstderr\b/, /\bemitWarning\b/, /\bglobalThis\b/, /\bglobal\b/, /\brequire\b/, /\bimport\s*\(/]) {
                if (re.test(code)) {
                    bad.push(`${fn}: ${re}`)
                }
            }
        }
        assert.deepStrictEqual(bad, [])
    })

    it('掃描非空轉: getDiag.mjs仍有console.log; 掃描器對各種直接輸出寫法皆命中', function() {
        let code = strip(fs.readFileSync(path.join(dirSrc, 'getDiag.mjs'), 'utf8'))
        assert.ok(/\bconsole\s*\.\s*log\b/.test(code))
        let res = [/\bconsole\b/, /\bprocess\b/, /\bstdout\b/, /\bstderr\b/, /\bemitWarning\b/, /\bglobalThis\b/, /\bglobal\b/, /\brequire\b/, /\bimport\s*\(/]
        for (let s of ['console.log(1)', 'console?.log(1)', 'let c = console', 'console["log"](1)', 'process.stdout.write(1)', 'process["stderr"].write(1)', 'process.emitWarning(1)', 'globalThis.console.log(1)', 'global.console.log(1)', 'require(\'util\')', 'import(\'util\')']) {
            assert.ok(res.some((re) => re.test(strip(s))), s)
        }
        assert.ok(!res.some((re) => re.test(strip('// console.log(1)\n/* process.stdout */ let a = 1'))))
    })

    it('WOrmLevel.mjs輸出診斷之兩個站點標籤: change handler threw、error handler threw', function() {
        let code = strip(fs.readFileSync(path.join(dirSrc, 'WOrmLevel.mjs'), 'utf8'))
        assert.ok(code.includes('\'change handler threw\''))
        assert.ok(code.includes('\'error handler threw\''))
    })

})
