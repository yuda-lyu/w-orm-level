import assert from 'assert'
import vm from 'vm'
import w from 'wsemi'
import { Level } from 'level'
import WOrm from '../src/WOrmLevel.mjs'
import { mkObserver } from './lib/mkObserver.mjs'
import { leaves, chkSame } from './lib/leaves.mjs'


//數據側(寫入)之Date範圍檢核(帳本R-DATE-01; 使用者2026-10-19裁示採A: 寫入時reject範圍外Date, fail-closed, 與條件側R-FIND-02一致)
//數據以JSON存值, Date經JSON序列化為toISOString()字串; 年份0000-9999恆為24字元(字典序即時間序), 範圍外(年份<0或>9999)帶+/-前綴而字典序顛倒,
//故「永不過期」哨兵new Date(8.64e15)會被delAll({t:{$lt:現在}})當成過去而刪除, 改為寫入時整批reject
//寫入入口: insert、insertBulk、save(自動插入、更新既有、autoInsert為false而主鍵不存在); 紀錄內任何深度之Date皆檢核
describe('date-write', function() {
    let url = './test/_tmp/date-write'
    let dbName = 'worm'
    let MS = {
        min: -62167219200000, //0000-01-01T00:00:00.000Z
        max: 253402300799999, //9999-12-31T23:59:59.999Z
        belowMin: -62167219200001, //-000001-12-31T23:59:59.999Z
        aboveMax: 253402300800000, //+010000-01-01T00:00:00.000Z
        big: 8.64e15, //+275760-09-13T00:00:00.000Z
        small: -8.64e15, //-271821-04-20T00:00:00.000Z
    }
    let D = (ms) => new Date(ms)
    let ok = () => D(Date.UTC(2026, 5, 1)) //2026-06-01T00:00:00.000Z
    let okIso = '2026-06-01T00:00:00.000Z'

    //ids, 取id集合(升冪)
    let ids = (rs) => rs.map((v) => v.id).sort()

    //sortRows
    let sortRows = (rows) => rows.sort((a, b) => (a.id < b.id ? -1 : 1))

    //image, 寫入後應讀回之樣子(JSON序列化之影像)
    let image = (v) => JSON.parse(JSON.stringify(v))

    //expectMsg, 本檢核之訊息(格式同條件側: invalid <對象>: 原因 at [路徑], 不回顯值)
    let expectMsg = (path) => `invalid data: Date year is out of range 0000-9999 at [${path}]`

    //opened與mk: 於測試資料夾下建立資料庫, after統一關閉
    let opened = []
    let mk = (name, opt = {}) => {
        let wo = WOrm({ url: `${url}/${name}`, db: dbName, cl: name, ...opt })
        opened.push(wo)
        return wo
    }

    //mkCorrupt: 建立「讀到主鍵p0即失敗」之資料庫(於p0放無法解碼之紀錄), 供驗證檢核先於任何讀取
    let mkCorrupt = async(name) => {
        let lv = new Level(`${url}/${name}/${dbName}/${name}`, { valueEncoding: 'buffer' })
        await lv.put('p0', Buffer.from('{ invalid JSON'))
        await lv.close()
        return mk(name)
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

    //entries: 寫入入口(5格). seedP為true者, 批次內主鍵p0-p4於寫入前已存在(save走更新). writes為false者不會真的寫入(autoInsert為false且主鍵不存在), 但同樣先經檢核
    //key為資料庫資料夾用之唯一名稱
    let entries = [
        { key: 'insert', name: 'insert', fn: 'insert', writes: true, seedP: false, call: (wo, d) => wo.insert(d) },
        { key: 'insertBulk', name: 'insertBulk', fn: 'insertBulk', writes: true, seedP: false, call: (wo, d) => wo.insertBulk(d) },
        { key: 'saveAuto', name: 'save (auto insert)', fn: 'save', writes: true, seedP: false, call: (wo, d) => wo.save(d) },
        { key: 'saveUpdate', name: 'save (update existing)', fn: 'save', writes: true, seedP: true, call: (wo, d) => wo.save(d) },
        { key: 'saveNoAuto', name: 'save (autoInsert false, id missing)', fn: 'save', writes: false, seedP: false, call: (wo, d) => wo.save(d, { autoInsert: false }) },
    ]

    //writeEntries: 會真的寫入之入口(4格); 凡依賴寫入結果(讀回值、儲存端錯誤)之案例只跑這些, 檢核本身之案例跑全部5格(檢核不依是否真會寫入而異)
    let writeEntries = entries.filter((v) => v.writes)

    //seedRows: 寫入前資料庫內之數據(皆為範圍內), seedP者另含p0-p4
    let seedRows = (entry) => {
        let rows = [{ id: 'base1', t: ok() }, { id: 'base2', n: 2 }]
        if (entry.seedP) {
            for (let i = 0; i < 5; i++) {
                rows.push({ id: `p${i}`, t: ok(), old: true })
            }
        }
        return rows
    }

    //expectedStored: 寫入成功後該筆應讀回之樣子(save更新為lodash merge之遞迴合併; 此處舊值僅t與old, 與新值之巢狀欄位無重疊, 故等同展開覆蓋; 巢狀合併另見專案案例)
    let expectedStored = (entry, rec) => {
        if (entry.seedP) {
            return { id: rec.id, t: okIso, old: true, ...image(rec) }
        }
        return image(rec)
    }

    let wo = null
    let ob = null

    //reset, 清空後依entry重建寫入前之數據
    let reset = async(entry) => {
        await wo.delAll()
        await wo.insertBulk(seedRows(entry))
    }

    //snap, 資料庫現況(升冪)
    let snap = async() => sortRows(await wo.select())

    before(function() {
        wo = mk('main')
        ob = mkObserver(wo)
    })

    //chkRej, 整批reject之共同斷言: 訊息逐字等於expect, error事件於reject前恰一次(訊息同reject、mode為該入口), 不發任何change(含save內逐筆之insert)
    let chkRej = (out, entry, expect) => {
        assert.strict.equal(out.ok, false, `${entry.name} should reject`)
        assert.strict.ok(out.err instanceof Error, `${entry.name} should reject with Error`)
        assert.strict.equal(out.err.message, expect, `${entry.name} message`)
        let evErr = out.evs.filter((v) => v.t === 'error')
        let evChg = out.evs.filter((v) => v.t === 'change')
        assert.strict.equal(evErr.length, 1, `${entry.name} should emit error exactly once`)
        assert.strict.equal(out.nAtSettle, 1, `${entry.name} should emit error before reject`)
        assert.strict.equal(evErr[0].settledAtEmit, false, `${entry.name} should emit error before reject`)
        assert.strict.equal(evErr[0].mode, entry.fn)
        assert.strict.equal(evErr[0].err, out.err.message, `${entry.name} error event should carry the reject message`)
        assert.strict.equal(evChg.length, 0, `${entry.name} should not emit change`)
    }

    //positions: 範圍外Date出現於紀錄內之位置(rec(d, x): d為待測值, x為同一紀錄內其餘Date), path為訊息內應給出之路徑
    let positions = [
        { name: 'top-level field', rec: (d) => [{ id: 'p0', t: d }], path: 'data[0].t' },
        { name: 'nested object', rec: (d) => [{ id: 'p0', o: { a: { b: d } } }], path: 'data[0].o.a.b' },
        { name: 'array first', rec: (d) => [{ id: 'p0', arr: [d, ok()] }], path: 'data[0].arr[0]' },
        { name: 'array middle', rec: (d) => [{ id: 'p0', arr: [ok(), d, ok()] }], path: 'data[0].arr[1]' },
        { name: 'array index 10', rec: (d) => [{ id: 'p0', arr: [...Array.from({ length: 10 }, () => ok()), d] }], path: 'data[0].arr[10]' },
        { name: 'object in array', rec: (d) => [{ id: 'p0', list: [{ x: ok() }, { x: d }] }], path: 'data[0].list[1].x' },
        { name: 'array in array', rec: (d) => [{ id: 'p0', m: [[ok()], [ok(), d]] }], path: 'data[0].m[1][1]' },
        { name: 'deep mixed', rec: (d) => [{ id: 'p0', a: { b: [{ c: { d: [ok(), { e: d }] } }] } }], path: 'data[0].a.b[0].c.d[1].e' },
        { name: 'second record', rec: (d) => [{ id: 'p0', t: ok() }, { id: 'p1', t: d }], path: 'data[1].t' },
        { name: 'fifth record', rec: (d) => [0, 1, 2, 3].map((i) => ({ id: `p${i}`, t: ok() })).concat([{ id: 'p4', t: d }]), path: 'data[4].t' },
        { name: 'beside valid Dates', rec: (d) => [{ id: 'p0', a: ok(), t: d, b: ok() }], path: 'data[0].t' },
        { name: 'several in one record (first by key order)', rec: (d, x) => [{ id: 'p0', t1: d, t2: x, t3: x }], path: 'data[0].t1' },
        { name: 'single object not array', rec: (d) => ({ id: 'p0', t: d }), path: 'data[0].t' },
        { name: 'bare Date as array element', rec: (d) => [d], path: 'data[0]', rejectOnly: true },
    ]
    let recsOf = (data) => (Array.isArray(data) ? data : [data])

    //bads: 範圍外之值(echo為不得出現在訊息內之年份片段)
    let bads = [
        { name: 'below 0000 (-000001-12-31T23:59:59.999Z)', ms: MS.belowMin, echo: ['000001'] },
        { name: 'above 9999 (+010000-01-01T00:00:00.000Z)', ms: MS.aboveMax, echo: ['010000'] },
        { name: 'new Date(8.64e15)', ms: MS.big, echo: ['275760'] },
        { name: 'new Date(-8.64e15)', ms: MS.small, echo: ['271821'] },
    ]

    //reject: 入口 × 範圍外之值 × 位置; 資料庫逐筆不變、呼叫端物件逐節點不變
    for (let entry of entries) {
        for (let bad of bads) {
            for (let pos of positions) {
                it(`should reject ${entry.name} by ${bad.name} at ${pos.name}`, async function() {
                    await reset(entry)
                    let before = await snap()
                    let data = pos.rec(D(bad.ms), D(MS.big))
                    let nodes = leaves(data)
                    let out = await ob.run(() => entry.call(wo, data))
                    chkRej(out, entry, expectMsg(pos.path))
                    for (let e of bad.echo) {
                        assert.strict.ok(out.err.message.indexOf(e) < 0, `message should not echo the value (${e}): ${out.err.message}`)
                    }
                    assert.strict.deepStrictEqual(await snap(), before, 'database should be unchanged')
                    chkSame(nodes, leaves(data)) //呼叫端實際傳入之同一物件逐節點不變
                })
            }
        }
    }

    //accept: 端點(0000-01-01T00:00:00.000Z、9999-12-31T23:59:59.999Z)與內側值, 入口 × 位置; 讀回值等於JSON影像
    let accepts = [
        '0000-01-01T00:00:00.000Z',
        '9999-12-31T23:59:59.999Z',
        '0000-01-01T00:00:00.001Z', //端點內側1毫秒
        '0000-12-31T23:59:59.999Z', //年份交界
        '1970-01-01T00:00:00.000Z',
        '9999-01-01T00:00:00.000Z',
        '9999-12-31T23:59:59.998Z', //端點內側1毫秒
    ]
    for (let entry of entries) {
        for (let iso of accepts) {
            it(`should accept ${entry.name} by ${iso} at every position`, async function() {
                assert.strict.equal(new Date(iso).toISOString(), iso)
                for (let pos of positions.filter((v) => !v.rejectOnly)) {
                    await reset(entry)
                    let before = await snap()
                    let data = pos.rec(new Date(iso), new Date(iso))
                    let out = await ob.run(() => entry.call(wo, data))
                    assert.strict.equal(out.ok, true, `${pos.name} should resolve but got: ${out.err}`)
                    assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0, `${pos.name} should not emit error`)
                    let after = await snap()
                    if (!entry.writes) {
                        assert.strict.deepStrictEqual(after, before, `${pos.name}: nothing is written`)
                        continue
                    }
                    let recs = recsOf(data)
                    let expect = sortRows(before.filter((r) => !recs.some((x) => x.id === r.id)).concat(recs.map((r) => expectedStored(entry, r))))
                    assert.strict.deepStrictEqual(after, expect, `${pos.name}: stored value should be the JSON image`)
                    assert.strict.ok(out.evs.some((v) => v.t === 'change' && v.mode === entry.fn), `${pos.name}: change should be emitted`)
                    if (pos.name === 'top-level field') {
                        assert.strict.equal((await wo.selectByPk('p0')).t, iso, 'stored as the fixed 24-char ISO string')
                        assert.strict.equal(iso.length, 24)
                    }
                }
            })
        }
    }

    //無效Date(Invalid Date): 既有處置不變, 序列化為null存入, 不reject(R-DATE-01規則2)
    for (let entry of entries) {
        it(`should keep storing invalid Date as null for ${entry.name}`, async function() {
            await reset(entry)
            let before = await snap()
            let data = [{ id: 'p0', t: new Date(NaN), arr: [new Date(NaN)], o: { u: new Date('x') } }]
            let out = await ob.run(() => entry.call(wo, data))
            assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
            assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 0)
            let after = await snap()
            if (!entry.writes) {
                assert.strict.deepStrictEqual(after, before)
                return
            }
            let rec = (await wo.selectByPk('p0'))
            assert.strict.deepStrictEqual(rec.t, null)
            assert.strict.deepStrictEqual(rec.arr, [null])
            assert.strict.deepStrictEqual(rec.o, { u: null })
        })
    }

    //Date形態: 以JSON序列化之結果判定(檢查之值即使用之值), 子類別、跨realm、被改Symbol.toStringTag/getTime者仍辨得出
    class SubDate extends Date {}
    let rejectForms = [
        { name: 'Date subclass', mk: (ms) => new SubDate(ms) },
        { name: 'cross-realm Date', mk: (ms) => vm.runInNewContext(`new Date(${ms})`) },
        { name: 'Date with own Symbol.toStringTag', mk: (ms) => { let d = new Date(ms); d[Symbol.toStringTag] = 'NotDate'; return d } },
        { name: 'Date with own getTime returning an in-range value', mk: (ms) => { let d = new Date(ms); d.getTime = () => 0; return d } },
    ]
    for (let entry of entries) {
        for (let form of rejectForms) {
            for (let bad of [MS.big, MS.small, MS.aboveMax, MS.belowMin]) {
                it(`should reject ${entry.name} by ${form.name} (${bad})`, async function() {
                    await reset(entry)
                    let before = await snap()
                    let out = await ob.run(() => entry.call(wo, { id: 'p0', t: form.mk(bad) }))
                    chkRej(out, entry, expectMsg('data[0].t'))
                    assert.strict.deepStrictEqual(await snap(), before)
                })
            }
        }

        //自有toISOString/toJSON覆寫: 序列化結果為範圍外字串者reject; 結果為範圍內字串或非字串者即存入該值
        it(`should reject ${entry.name} by Date whose own toISOString gives an out-of-range string`, async function() {
            await reset(entry)
            let d = ok()
            d.toISOString = () => '+275760-09-13T00:00:00.000Z'
            let out = await ob.run(() => entry.call(wo, { id: 'p0', t: d }))
            chkRej(out, entry, expectMsg('data[0].t'))
        })
        it(`should reject ${entry.name} by Date whose own toJSON gives an out-of-range string`, async function() {
            await reset(entry)
            let d = ok()
            d.toJSON = () => '-271821-04-20T00:00:00.000Z'
            let out = await ob.run(() => entry.call(wo, { id: 'p0', t: d }))
            chkRej(out, entry, expectMsg('data[0].t'))
        })
        it(`should inspect own properties of a Date whose toJSON is not callable for ${entry.name}`, async function() {
            await reset(entry)
            let d = ok()
            d.toJSON = null //不可呼叫之toJSON: JSON序列化視為一般物件, 自有屬性照常輸出
            d.extra = D(MS.big)
            let out = await ob.run(() => entry.call(wo, [{ id: 'p0', t: d }]))
            chkRej(out, entry, expectMsg('data[0].t.extra'))
        })
        it(`should store what own toISOString/toJSON give when it is an in-range string or not a string for ${entry.name}`, async function() {
            await reset(entry)
            let d1 = D(MS.big)
            d1.toISOString = () => '2020-01-01T00:00:00.000Z' //序列化結果為範圍內字串(實際存入之值即檢查之值)
            let d2 = D(MS.small)
            d2.toJSON = () => '2021-01-01T00:00:00.000Z'
            let d3 = D(MS.big)
            d3.toJSON = () => 5 //非字串, 不是日期字串
            let out = await ob.run(() => entry.call(wo, [{ id: 'p0', a: d1, b: d2, c: d3 }]))
            assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
            if (!entry.writes) {
                return
            }
            let rec = await wo.selectByPk('p0')
            assert.strict.equal(rec.a, '2020-01-01T00:00:00.000Z')
            assert.strict.equal(rec.b, '2021-01-01T00:00:00.000Z')
            assert.strict.equal(rec.c, 5)
        })
    }

    //不檢核者(R-DATE-01規則6): 已是字串、Map/Set內之Date、Buffer(含其自有屬性)、非Date之toJSON物件(其輸出不檢核, 此為已載明之範圍邊界); 只驗證其存入行為不變
    for (let entry of writeEntries) {
        it(`should not inspect strings, Map, Set, Buffer and non-Date toJSON objects for ${entry.name}`, async function() {
            await reset(entry)
            let big = '+275760-09-13T00:00:00.000Z'
            let buf = Buffer.from('ab')
            buf.bad = D(MS.big) //Buffer序列化取其toJSON輸出({type,data}), 自有屬性不輸出
            let rec = {
                id: 'p0',
                s1: big, //已序列化之字串不是Date物件
                s2: '-271821-04-20T00:00:00.000Z',
                m: new Map([['k', D(MS.big)]]), //Map序列化為{}
                st: new Set([D(MS.big)]), //Set序列化為{}
                b: buf,
                ta: new Uint8Array([1, 2]), //無自有屬性之TypedArray照常序列化為索引鍵物件
                j: { toJSON() { return 'custom' } },
                j2: { toJSON() { return { d: D(MS.big) } } }, //非Date之toJSON輸出內含範圍外Date: 不檢核(範圍邊界)
            }
            let out = await ob.run(() => entry.call(wo, [rec]))
            assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
            let got = await wo.selectByPk('p0')
            assert.strict.equal(got.s1, big)
            assert.strict.equal(got.s2, '-271821-04-20T00:00:00.000Z')
            assert.strict.deepStrictEqual(got.m, {})
            assert.strict.deepStrictEqual(got.st, {})
            assert.strict.deepStrictEqual(got.b, { type: 'Buffer', data: [97, 98] })
            assert.strict.deepStrictEqual(got.ta, { 0: 1, 1: 2 })
            assert.strict.equal(got.j, 'custom')
            assert.strict.deepStrictEqual(got.j2, { d: big })
        })
    }

    //ArrayBuffer視圖: Buffer取toJSON輸出而不含自有屬性(不走訪); 其餘視圖(TypedArray、DataView)無toJSON, 自有屬性照常序列化, 其內之範圍外Date須拒收(外審F-01)
    for (let entry of entries) {
        for (let [name, mkv] of [
            ['Uint8Array', () => new Uint8Array([1, 2])],
            ['Float64Array', () => new Float64Array(2)],
            ['DataView', () => new DataView(new ArrayBuffer(2))],
        ]) {
            it(`should reject ${entry.name} by out-of-range Date set on a ${name}`, async function() {
                await reset(entry)
                let before = await snap()
                let view = mkv()
                view.bad = D(MS.big)
                let out = await ob.run(() => entry.call(wo, [{ id: 'p0', v: view }]))
                chkRej(out, entry, expectMsg('data[0].v.bad'))
                assert.strict.deepStrictEqual(await snap(), before)
            })
        }
        it(`should accept ${entry.name} by out-of-range Date set on a Buffer because JSON takes its toJSON output only`, async function() {
            await reset(entry)
            let buf = Buffer.from([1, 2])
            buf.bad = D(MS.big)
            let out = await ob.run(() => entry.call(wo, [{ id: 'p0', b: buf }]))
            assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
            if (entry.writes) {
                assert.strict.deepStrictEqual((await wo.selectByPk('p0')).b, { type: 'Buffer', data: [1, 2] })
            }
        })
    }

    //循環參照與BigInt: 既有結果不變(真的要寫入者於寫入時JSON序列化拋錯; 不會寫入者〔autoInsert為false而主鍵不存在〕不序列化故照常resolve); 檢核只略過回邊, 不吞掉兄弟節點之檢查
    for (let entry of writeEntries) {
        it(`should keep rejecting circular structure by the storage error for ${entry.name}`, async function() {
            await reset(entry)
            let o = { id: 'p0', t: ok() }
            o.self = o
            let out = await ob.run(() => entry.call(wo, o))
            assert.strict.equal(out.ok, false)
            assert.strict.ok(/circular/i.test(out.err.message), out.err.message)
            assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 1)
        })
        it(`should keep rejecting BigInt by the storage error for ${entry.name}`, async function() {
            await reset(entry)
            let out = await ob.run(() => entry.call(wo, { id: 'p0', n: 1n }))
            assert.strict.equal(out.ok, false)
            assert.strict.ok(/BigInt/.test(out.err.message), out.err.message)
        })
    }
    for (let entry of entries) {
        it(`should report the Date even when the record is circular (${entry.name})`, async function() {
            await reset(entry)
            let o = { id: 'p0' }
            o.self = o //回邊在前, 其後之兄弟節點仍須檢查
            o.t = D(MS.big)
            o.arr = [o, D(MS.small)]
            let out = await ob.run(() => entry.call(wo, o))
            chkRej(out, entry, expectMsg('data[0].t'))
        })
    }
    it('should keep resolving save(autoInsert:false) of a circular record that is not written', async function() {
        await reset(entries[4])
        let o = { id: 'nothere' }
        o.self = o
        let out = await ob.run(() => wo.save(o, { autoInsert: false }))
        assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
        assert.strict.deepStrictEqual(out.val, [{ n: 0, nInserted: 0, nModified: 0, ok: 1 }])
    })

    //共用參照(菱形圖,如 cur = { x: prev, y: prev })只走訪一次(外審F-06): 深度28之圖僅30個物件, 逐路徑走訪需2^28次; save(autoInsert:false)不會序列化, 耗時全在檢核
    it('should walk a diamond-shaped shared-reference graph in linear time', async function() {
        await reset(entries[4])
        let cur = { v: 1 }
        for (let i = 0; i < 28; i++) {
            cur = { x: cur, y: cur }
        }
        let t0 = Date.now()
        let out = await ob.run(() => wo.save({ id: 'nothere', dag: cur }, { autoInsert: false }))
        assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
        assert.strict.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`)
    })
    for (let entry of entries) {
        it(`should report the first path to an out-of-range Date inside a shared-reference graph for ${entry.name}`, async function() {
            await reset(entry)
            let leaf = { t: D(MS.big) }
            let cur = leaf
            for (let i = 0; i < 3; i++) {
                cur = { x: cur, y: cur }
            }
            let shared = D(MS.small) //同一個Date物件被兩處引用: 回報先走到的路徑
            let out = await ob.run(() => entry.call(wo, [{ id: 'p0', a: shared, b: shared }]))
            chkRej(out, entry, expectMsg('data[0].a'))
            out = await ob.run(() => entry.call(wo, [{ id: 'p0', dag: cur }]))
            chkRej(out, entry, expectMsg('data[0].dag.x.x.x.t'))
        })
    }

    //呼叫端無id之紀錄: 補id只發生在複本, reject後呼叫端物件仍無id
    for (let entry of entries) {
        it(`should leave the caller record without id untouched when ${entry.name} rejects`, async function() {
            await reset(entry)
            let before = await snap()
            let rec = { t: D(MS.big) }
            let nodes = leaves(rec)
            let out = await ob.run(() => entry.call(wo, rec))
            chkRej(out, entry, expectMsg('data[0].t'))
            assert.strict.deepStrictEqual(Object.keys(rec), ['t'])
            chkSame(nodes, leaves(rec))
            assert.strict.deepStrictEqual(await snap(), before)
        })
    }

    //路徑格式: 資料之鍵不受白名單文法約束, 非一般識別字者以JSON字串括號法表示, 過長者截短(單鍵>30字元取前30加..., 全路徑>120取...加末100字元)
    let keyCases = [
        { name: 'identifier', key: 'abc', seg: '.abc' },
        { name: 'underscore and digits', key: '_a1', seg: '._a1' },
        { name: 'dollar prefix', key: '$meta', seg: '.$meta' },
        { name: 'non-ASCII letters', key: '日期', seg: '.日期' },
        { name: 'starts with digit', key: '1a', seg: '["1a"]' },
        { name: 'with dot', key: 'a.b', seg: '["a.b"]' },
        { name: 'with space', key: 'a b', seg: '["a b"]' },
        { name: 'with hyphen', key: 'a-b', seg: '["a-b"]' },
        { name: 'with bracket', key: 'a]b', seg: '["a]b"]' },
        { name: 'with double quote', key: 'a"b', seg: '["a\\"b"]' },
        { name: 'with newline', key: 'a\nb', seg: '["a\\nb"]' },
        { name: 'empty', key: '', seg: '[""]' },
        { name: 'lone surrogate', key: 'a\ud800b', seg: '["a\\ud800b"]' },
        { name: 'identifier of 30 chars', key: 'k'.repeat(30), seg: `.${'k'.repeat(30)}` },
        { name: 'identifier of 31 chars', key: 'k'.repeat(31), seg: `.${'k'.repeat(30)}...` },
        { name: 'identifier of 128 chars', key: 'k'.repeat(128), seg: `.${'k'.repeat(30)}...` },
        { name: 'non-identifier of 30 chars', key: `a b${'k'.repeat(27)}`, seg: `["a b${'k'.repeat(27)}"]` },
        { name: 'non-identifier of 31 chars', key: `a b${'k'.repeat(28)}`, seg: `["a b${'k'.repeat(27)}..."]` },
        { name: 'surrogate pair cut at 30 chars', key: `${'a'.repeat(29)}\u{10400}b`, seg: `.${'a'.repeat(29)}?...` },
        { name: 'astral letter ending exactly at 30 chars', key: `${'a'.repeat(28)}\u{10400}${'b'.repeat(5)}`, seg: `.${'a'.repeat(28)}\u{10400}...` },
        { name: 'astral non-letter ending exactly at 30 chars', key: `${'x'.repeat(28)}\u{1F389}${'y'.repeat(5)}`, seg: `["${'x'.repeat(28)}\u{1F389}..."]` },
    ]
    for (let entry of entries) {
        for (let kc of keyCases) {
            it(`should render the key path for ${entry.name} by ${kc.name}`, async function() {
                await reset(entry)
                let rec = { id: 'p0', o: {} }
                rec.o[kc.key] = D(MS.big)
                let out = await ob.run(() => entry.call(wo, [rec]))
                chkRej(out, entry, expectMsg(`data[0].o${kc.seg}`))
            })
        }

        //全路徑長度: 120(不截短)、121(截短)、更長
        for (let n of [120, 121, 122, 200]) {
            it(`should truncate the whole path longer than 120 chars for ${entry.name} (${n} chars)`, async function() {
                await reset(entry)
                let head = 'data[0]'
                let keys = []
                let len = head.length
                while (len + 11 <= n - 15) { //每段'.'加10字元
                    keys.push('k'.repeat(10))
                    len += 11
                }
                let last = 'z'.repeat(n - len - 1) //最末段補足至n字元(<=30字元)
                assert.strict.ok(last.length >= 1 && last.length <= 30, `last key length ${last.length}`)
                keys.push(last)
                let full = head + keys.map((k) => `.${k}`).join('')
                assert.strict.equal(full.length, n)
                let o = D(MS.big)
                for (let i = keys.length - 1; i >= 0; i--) {
                    o = { [keys[i]]: o }
                }
                let rec = { id: 'p0' }
                Object.assign(rec, o) //keys[0]直接掛在紀錄上
                let out = await ob.run(() => entry.call(wo, [rec]))
                let expect = full.length > 120 ? `...${full.slice(-100)}` : full
                chkRej(out, entry, expectMsg(expect))
            })
        }
    }

    //呼叫之後、佇列執行之前呼叫端改動Date: 不變式「資料庫內不得出現範圍外Date字串」(檢核須針對實際寫入之值)
    for (let entry of entries) {
        it(`should never store an out-of-range time set on the same Date object after the call for ${entry.name}`, async function() {
            await reset(entry)
            let d = ok()
            let data = { id: 'p0', t: d }
            let out = await ob.run(() => {
                let pm = entry.call(wo, data)
                d.setTime(MS.big) //就地改動同一個Date物件(淺複製不會抓到, 須複製Date本身)
                return pm
            })
            let all = JSON.stringify(await snap())
            assert.strict.ok(all.indexOf('+275760') < 0, 'no out-of-range string in database')
            if (!out.ok) {
                assert.strict.equal(out.err.message, expectMsg('data[0].t'))
            }
        })
        it(`should never store an out-of-range Date set after the call for ${entry.name}`, async function() {
            await reset(entry)
            let data = { id: 'p0', t: ok(), arr: [ok()] }
            let out = await ob.run(() => {
                let pm = entry.call(wo, data)
                data.t = D(MS.big) //呼叫之後同步改動, 佇列執行時才複製與檢核
                data.arr[0] = D(MS.small)
                return pm
            })
            let all = JSON.stringify(await snap())
            assert.strict.ok(all.indexOf('+275760') < 0 && all.indexOf('-271821') < 0, 'no out-of-range string in database')
            if (!out.ok) {
                assert.strict.equal(out.err.message, expectMsg('data[0].t'))
            }
        })
        it(`should never store an out-of-range Date that is replaced after the call for ${entry.name}`, async function() {
            await reset(entry)
            let data = { id: 'p0', t: D(MS.big) }
            let out = await ob.run(() => {
                let pm = entry.call(wo, data)
                data.t = ok()
                return pm
            })
            let all = JSON.stringify(await snap())
            assert.strict.ok(all.indexOf('+275760') < 0, 'no out-of-range string in database')
            if (!out.ok) {
                assert.strict.equal(out.err.message, expectMsg('data[0].t'))
            }
        })
    }

    //佇列順序: 檢核於佇列內, 先排入之寫入先完成並先發change, 其後之壞寫入才reject, 再其後之寫入照常
    it('should keep queue order: earlier writes finish before a later bad write rejects, and later writes go on', async function() {
        await reset(entries[0])
        let out = await ob.run(async() => {
            let p1 = wo.insertBulk([{ id: 'q1', t: ok() }])
            let p2 = wo.insert({ id: 'q2', t: D(MS.big) }).catch((err) => err)
            let p3 = wo.save({ id: 'q3', t: ok() })
            return Promise.all([p1, p2, p3])
        })
        assert.strict.equal(out.ok, true)
        assert.strict.ok(out.val[1] instanceof Error)
        assert.strict.equal(out.val[1].message, expectMsg('data[0].t'))
        assert.strict.deepStrictEqual(out.evs.map((v) => `${v.t}:${v.mode}`), ['change:insertBulk', 'error:insert', 'change:insert', 'change:save'])
        assert.strict.deepStrictEqual(ids(await snap()), ['base1', 'base2', 'q1', 'q3'])
    })

    //useCache: reject後快取不殘留舊值, 其後之合法寫入可見
    it('should keep select consistent after a rejected write with useCache', async function() {
        let w1 = mk('cache', { useCache: true })
        await w1.insertBulk([{ id: 'a', t: ok() }])
        assert.strict.deepStrictEqual(ids(await w1.select()), ['a']) //暖快取
        let o1 = mkObserver(w1)
        let out = await o1.invoke('insert', { id: 'b', t: D(MS.big) })
        assert.strict.equal(out.ok, false)
        assert.strict.deepStrictEqual(ids(await w1.select()), ['a'])
        await w1.insert({ id: 'c', t: ok() })
        assert.strict.deepStrictEqual(ids(await w1.select()), ['a', 'c'])
    })

    //已關閉先於本檢核: 與其他整批錯誤之順序一致
    for (let entry of entries) {
        it(`should reject with closed message before date check after close for ${entry.name}`, async function() {
            let w1 = mk(`closed-${entry.key}`)
            await w1.insert({ id: 'x1', t: ok() })
            await w1.close()
            let o1 = mkObserver(w1)
            let out = await o1.run(() => entry.call(w1, { id: 'y1', t: D(MS.big) }))
            assert.strict.equal(out.ok, false)
            assert.strict.ok(out.err.message.indexOf(`can not ${entry.fn} by closed client`) === 0, out.err.message)
            assert.strict.equal(out.evs.filter((v) => v.t === 'error').length, 1)
        })
    }

    //autoGenPk為false: 缺主鍵之既有錯誤先於本檢核(既有優先序不變), 帶主鍵者才進本檢核
    for (let entry of entries) {
        it(`should keep the missing id error before date check when autoGenPk is false for ${entry.name}`, async function() {
            let w1 = mk(`nogen-${entry.key}`, { autoGenPk: false })
            let o1 = mkObserver(w1)
            let out = await o1.run(() => entry.call(w1, { t: D(MS.big) }))
            assert.strict.equal(out.ok, false)
            assert.strict.equal(out.err.message, `can not ${entry.fn} by data[0] without valid id when autoGenPk is false`)
            out = await o1.run(() => entry.call(w1, { id: 'a', t: D(MS.big) }))
            assert.strict.equal(out.ok, false)
            assert.strict.equal(out.err.message, expectMsg('data[0].t'))
            assert.strict.deepStrictEqual(await w1.select(), [])
        })
    }

    //檢核先於任何讀取(R-DATE-01規則1): 資料庫內放一筆「讀到主鍵p0即失敗」之壞資料(對照: 合法數據會讀到它而失敗), 帶範圍外Date者須先得到本檢核之錯誤
    for (let entry of entries) {
        it(`should check Date before reading the database for ${entry.name}`, async function() {
            let w1 = await mkCorrupt(`noread-${entry.key}`)
            let o1 = mkObserver(w1)
            let ctrl = await o1.run(() => entry.call(w1, [{ id: 'p0', t: ok() }]))
            assert.strict.equal(ctrl.ok, false, 'control: valid data should hit the corrupt record and fail')
            assert.strict.ok(ctrl.err.message.indexOf('invalid data') < 0, ctrl.err.message)
            let out = await o1.run(() => entry.call(w1, [{ id: 'p0', t: D(MS.big) }]))
            chkRej(out, entry, expectMsg('data[0].t'))
        })
    }

    //主鍵已存在或同批重複者亦先經檢核(insert遇已存在主鍵原本靜默跳過該筆、insertBulk原本以主鍵衝突reject): 範圍外Date優先, 整批reject
    for (let entry of [entries[0], entries[1]]) {
        it(`should reject ${entry.name} by out-of-range Date even when the id already exists`, async function() {
            await reset(entry)
            let before = await snap()
            let out = await ob.run(() => entry.call(wo, [{ id: 'base1', t: D(MS.big) }]))
            chkRej(out, entry, expectMsg('data[0].t'))
            assert.strict.deepStrictEqual(await snap(), before)
        })
        it(`should reject ${entry.name} by out-of-range Date in a record whose id repeats within the batch`, async function() {
            await reset(entry)
            let before = await snap()
            let out = await ob.run(() => entry.call(wo, [{ id: 'dup', t: ok() }, { id: 'dup', t: D(MS.big) }]))
            chkRej(out, entry, expectMsg('data[1].t'))
            assert.strict.deepStrictEqual(await snap(), before)
        })
    }

    //save之合併(lodash merge為遞迴合併): 巢狀物件合併時新值之Date照常檢核; 同批同主鍵之後筆合併入前筆, 任一筆範圍外即整批reject
    it('should deep-merge nested objects in save update and check the incoming Date', async function() {
        await wo.delAll()
        await wo.insertBulk([{ id: 'p0', o: { keep: 1, a: { x: 1 } }, t: okIso }])
        let out = await ob.run(() => wo.save({ id: 'p0', o: { a: { y: D(Date.UTC(2020, 0, 1)) } } }))
        assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
        assert.strict.deepStrictEqual(await wo.selectByPk('p0'), { id: 'p0', o: { keep: 1, a: { x: 1, y: '2020-01-01T00:00:00.000Z' } }, t: okIso })
        let before = await snap()
        out = await ob.run(() => wo.save({ id: 'p0', o: { a: { y: D(MS.big) } } }))
        chkRej(out, entries[3], expectMsg('data[0].o.a.y'))
        assert.strict.deepStrictEqual(await snap(), before)
    })
    it('should merge a later record of the same id into the earlier one in one save batch and reject the whole batch when either is out of range', async function() {
        await wo.delAll()
        let out = await ob.run(() => wo.save([{ id: 'p0', a: { x: ok() } }, { id: 'p0', a: { y: D(Date.UTC(2020, 0, 1)) } }]))
        assert.strict.equal(out.ok, true, `should resolve but got: ${out.err}`)
        assert.strict.deepStrictEqual(await wo.selectByPk('p0'), { id: 'p0', a: { x: okIso, y: '2020-01-01T00:00:00.000Z' } })
        await wo.delAll()
        out = await ob.run(() => wo.save([{ id: 'p0', a: { x: ok() } }, { id: 'p0', a: { y: D(MS.big) } }]))
        chkRej(out, entries[2], expectMsg('data[1].a.y'))
        out = await ob.run(() => wo.save([{ id: 'p0', a: { x: D(MS.small) } }, { id: 'p0', a: { y: ok() } }]))
        chkRej(out, entries[2], expectMsg('data[0].a.x'))
        assert.strict.deepStrictEqual(await snap(), [])
    })

    //情境: 原始外審場景「永不過期哨兵new Date(8.64e15)存入後被delAll({t:{$lt:現在}})刪除」改為寫入即reject
    describe('sentinel', function() {
        it('should reject the sentinel on write so that delAll by now can not delete it', async function() {
            let w1 = mk('sentinel')
            await w1.insertBulk([{ id: 'past', t: D(Date.UTC(2020, 0, 1)) }, { id: 'future', t: D(Date.UTC(2099, 0, 1)) }])
            await assert.rejects(() => w1.insert({ id: 'forever', t: D(8.64e15) }), { message: expectMsg('data[0].t') })
            await assert.rejects(() => w1.insertBulk([{ id: 'forever', t: D(8.64e15) }]), { message: expectMsg('data[0].t') })
            await assert.rejects(() => w1.save({ id: 'forever', t: D(8.64e15) }), { message: expectMsg('data[0].t') })
            assert.strict.deepStrictEqual(ids(await w1.select()), ['future', 'past'])
            let r = await w1.delAll({ t: { $lt: new Date() } })
            assert.strict.deepStrictEqual(r, { n: 1, nDeleted: 1, ok: 1 })
            assert.strict.deepStrictEqual(ids(await w1.select()), ['future'])
        })

        it('should keep null and 9999-12-31T23:59:59.999Z as never-expire alternatives that now-conditions do not hit', async function() {
            let w1 = mk('alt')
            await w1.insertBulk([
                { id: 'past', t: D(Date.UTC(2020, 0, 1)) },
                { id: 'nul', t: null },
                { id: 'end9999', t: new Date('9999-12-31T23:59:59.999Z') },
            ])
            assert.strict.deepStrictEqual(ids(await w1.select({ t: { $lt: new Date() } })), ['past'])
            let r = await w1.delAll({ t: { $lt: new Date() } })
            assert.strict.deepStrictEqual(r, { n: 1, nDeleted: 1, ok: 1 })
            assert.strict.deepStrictEqual(ids(await w1.select()), ['end9999', 'nul'])
            assert.strict.deepStrictEqual(ids(await w1.select({ t: { $gt: D(Date.UTC(2099, 0, 1)) } })), ['end9999'])
        })

        //既有資料不遷移、不改讀取(R-DATE-01規則7): 已存在之範圍外Date字串仍有字典序風險, 可讀回後以save改寫清理
        it('should leave legacy out-of-range strings readable and uncomparable, and let save rewrite them', async function() {
            let w1 = mk('legacy')
            await w1.insertBulk([
                { id: 'legacyBig', t: '+275760-09-13T00:00:00.000Z' }, //舊版寫入之哨兵(字串不是Date物件, 寫入照常)
                { id: 'legacySmall', t: '-271821-04-20T00:00:00.000Z' },
                { id: 'future', t: D(Date.UTC(2099, 0, 1)) },
            ])
            assert.strict.equal((await w1.selectByPk('legacyBig')).t, '+275760-09-13T00:00:00.000Z')

            //字典序: '+275760-…'與'-271821-…'皆小於'2026-…', 故$lt現在命中二者(legacyBig按時間序屬未來, 為文件所載之既有資料風險)
            assert.strict.deepStrictEqual(ids(await w1.select({ t: { $lt: new Date() } })), ['legacyBig', 'legacySmall'])

            //讀回再存回(字串)可行, 其餘欄位更新不受影響
            let row = await w1.selectByPk('legacyBig')
            await w1.save({ ...row, n: 2 })
            assert.strict.deepStrictEqual(await w1.selectByPk('legacyBig'), { id: 'legacyBig', t: '+275760-09-13T00:00:00.000Z', n: 2 })

            //清理: 改寫為null或範圍內之值後不再被命中
            await w1.save({ id: 'legacyBig', t: null })
            await w1.save({ id: 'legacySmall', t: new Date('0001-01-01T00:00:00.000Z') })
            assert.strict.deepStrictEqual(ids(await w1.select({ t: { $lt: new Date() } })), ['legacySmall'])

            //以Date改寫為範圍外值仍被拒收, 資料不變
            await assert.rejects(() => w1.save({ id: 'legacyBig', t: D(MS.big) }), { message: expectMsg('data[0].t') })
            assert.strict.equal((await w1.selectByPk('legacyBig')).t, null)
        })
    })
})
