import assert from 'assert'
import w from 'wsemi'
import { Level } from 'level'
import WOrm from '../src/WOrmLevel.mjs'


//主鍵(id)只認「自有可列舉之資料屬性」, 規則見sgud/rule/rulebook.md R-PKOWN-01(第569項全族規則, 承w-orm-lowdb之olw569)
//缺陷(修前, 1.0.69): 呼叫端之列其id為繼承(原型鏈上, 如Object.create({ id: 'a9' })或類別實例原型上之getter/資料屬性)時, cloneDeep保留原型,
//  procPk以get(v, 'id')讀得原型上之字串而判為「已帶」, 資料庫以JSON序列化只存自有可列舉屬性, 故以繼承值為鍵寫入無id欄之列(主鍵遺失);
//  或與資料庫內同值之既有列衝突(insert靜默跳過、insertBulk整批reject、save覆寫該既有列、del刪除該既有列)
//規格(主控裁示, 第569項):
//  O1 主鍵只認自有可列舉之資料屬性: id為繼承(原型鏈上)或自有不可列舉者視為「未帶」(與undefined、null、空字串同); 不論繼承值為字串、數字或物件
//  O2 autoGenPk為true: insert、insertBulk、save補新主鍵(自有可列舉之UUIDv7字串), 資料庫內該列帶此id欄; 繼承值不得被當成主鍵(不跳過、不衝突、不覆寫、不刪除同值之既有列)
//  O3 autoGenPk為false: 依既有「未帶」之拒絕(can not <入口> by data[k] without valid id when autoGenPk is false), 整批reject, error事件恰一次, 資料庫不變
//  O4 del: 繼承之id視為未給, 該筆ok為0並附invalid id: not a string at [data[k].id], 同值之既有列不被刪除; 繼承之有效字串不送進後端查詢; 其餘既有處置不變(繼承之空字串、數字照原訊息)
//  O5 selectByPk收純量pk, 無「列」之繼承問題; 傳入物件(帶繼承id)者回null且不發事件(既有契約)
//  O6 自有可列舉之id(含自有遮蔽繼承者、自有存取器經複製成資料屬性)行為不變: 以自有值存入
//  O7 寫入之列只含自有可列舉之欄位; 任何寫入後資料庫內每一筆之鍵等於該列之id欄(不得出現「判為已帶之id未被存入」之列)
//  O8 判定不多讀有效輸入: 自有存取器id之getter恆只被讀1次(複製時); 繼承存取器id之getter於insert、insertBulk、save亦只被讀1次(既有路徑取值), del為2次(既有: 整批取鍵與逐筆各1次), 不因判定而多讀
//  O9 補主鍵不經賦值: 原型上之setter不被執行(執行呼叫端之程式), 凍結之原型與僅有getter之原型皆不致拋錯
//  O10 非物件之列(字串、數字)維持既有之原生TypeError(補主鍵之賦值)與autoGenPk為false時之「未帶」拒絕; 取值先於查描述子(繼承存取器id之getter照既有路徑讀1次, 見O8)
//  O11 查描述子亦經既有之try/guardRead: cloneDeep不複製陣列內之函數(Proxy包裝之函數其陷阱會執行呼叫端之程式), 其getOwnPropertyDescriptor陷阱拋錯者轉固定詞彙(口徑A2), 不轉出拋出者之文字
//每案使用全新資料庫目錄; 驗證直讀資料庫(關閉實例後以Level讀鍵與值, 不經被測物件之讀取函數); 各案之繼承值與列內容逐案相異
describe('pk own enumerable only', function() {
    let url = './test/_tmp/pk-own'
    let nCase = 0
    let nVal = 0
    let opened = []

    //reUuid, genIDSeq產生之主鍵(UUIDv7)
    let reUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

    let msgOf = (err) => (err instanceof Error ? err.message : String(err))

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

    //mk, 每案全新資料庫目錄
    let mk = (opt = {}) => {
        nCase++
        let name = `c${nCase}`
        let dir = `${url}/${name}`
        let wo = WOrm({ url: dir, db: 'worm', cl: name, ...opt })
        opened.push(wo)
        let evs = []
        wo.on('error', (mode, data, err) => {
            evs.push({ type: 'error', mode, data, err })
        })
        wo.on('change', (mode, data, res) => {
            evs.push({ type: 'change', mode, data, res })
        })
        return { wo, evs, storage: `${dir}/worm/${name}` }
    }

    //rows, 以被測物件之select取全部列(鍵序), 供寫入前後之快照
    let rows = async(c) => {
        return c.wo.select()
    }

    //raw, 關閉實例後直讀資料庫取[鍵, 值](每案只在最後呼叫一次)
    let raw = async(c) => {
        await c.wo.close()
        let db = new Level(c.storage, { valueEncoding: 'json' })
        await db.open()
        let out = []
        for await (let [k, v] of db.iterator()) {
            out.push([k, v])
        }
        await db.close()
        return out
    }

    //chkKeyIsId, O7: 資料庫內每一筆之鍵等於該列之id欄(字串), 不得出現「判為已帶之id未被存入」之列
    let chkKeyIsId = (kvs) => {
        assert.ok(kvs.length > 0, 'the database must hold rows (a vacuous check is not a check)')
        for (let [k, v] of kvs) {
            assert.ok(Object.prototype.hasOwnProperty.call(v, 'id') && typeof v.id === 'string' && v.id !== '', `row without id: key=${k} value=${JSON.stringify(v)}`)
            assert.strictEqual(v.id, k, `key must equal the id field: key=${k} id=${v.id}`)
        }
    }

    let nType = (evs, type, mode) => evs.filter((v) => v.type === type && (mode === undefined || v.mode === mode)).length

    //uniq, 逐案相異之值(繼承id、列名、數值皆取自此, 看值即知來自哪一案)
    let uniq = () => {
        nVal++
        return nVal
    }

    //seed, 先寫入既有列: 兩筆其他列與(collide時)一筆與繼承值同id之列; 回傳seed後之快照
    let seed = async(c, idv, collide, extraIds = []) => {
        let k = uniq()
        await c.wo.insert({ id: `seed-a-${k}`, name: `seed-name-${k}`, v: k * 10 + 1 })
        await c.wo.insert({ id: `seed-b-${k}`, name: `seed-name-b-${k}`, v: k * 10 + 2 })
        if (collide) {
            await c.wo.insert({ id: idv, name: `seed-collide-${k}`, v: k * 10 + 3 })
            for (let eid of extraIds) {
                await c.wo.insert({ id: eid, name: `seed-collide-extra-${k}`, v: k * 10 + 4 })
            }
        }
        c.evs.length = 0
        return rows(c)
    }

    //列形態: make(idv, nm)回傳一筆列; inhStr為true者其繼承值為字串(可與資料庫內同值之既有列衝突), 其餘為非字串或無繼承之值
    let mkClassGetter = (idv, nm) => {
        class C {
            get id() {
                return idv
            }
        }
        let o = new C()
        o.name = nm
        return o
    }
    let shapes = [
        {
            name: 'inherited string (plain prototype)',
            inhStr: true,
            make: (idv, nm) => Object.assign(Object.create({ id: idv }), { name: nm }),
        },
        {
            name: 'inherited string via class getter (getter-only on prototype)',
            inhStr: true,
            make: mkClassGetter,
        },
        {
            name: 'inherited string from frozen prototype',
            inhStr: true,
            make: (idv, nm) => Object.assign(Object.create(Object.freeze({ id: idv })), { name: nm }),
        },
        {
            name: 'own non-enumerable id shadowing inherited string',
            inhStr: true,
            extraIds: (idv) => [`ne-${idv}`], //自有不可列舉之值亦為庫內既有列之主鍵(皆不得被動到)
            make: (idv, nm) => {
                let o = Object.create({ id: idv })
                o.name = nm
                Object.defineProperty(o, 'id', { value: `ne-${idv}`, enumerable: false })
                return o
            },
        },
        {
            name: 'own non-enumerable id, nothing inherited',
            inhStr: false,
            collidable: true,
            extraIds: (idv) => [`ne-${idv}`],
            make: (idv, nm) => {
                let o = { name: nm }
                Object.defineProperty(o, 'id', { value: `ne-${idv}`, enumerable: false })
                return o
            },
        },
        {
            name: 'inherited number',
            inhStr: false,
            make: (idv, nm) => Object.assign(Object.create({ id: 1000 + Number(idv.replace('inh-', '')) }), { name: nm }),
        },
        {
            name: 'inherited object',
            inhStr: false,
            make: (idv, nm) => Object.assign(Object.create({ id: { a: `OBJ-${nm}` } }), { name: nm }),
        },
    ]

    for (let autoGenPk of [true, false]) {

        describe(`autoGenPk: ${autoGenPk}`, function() {

            //O2、O3、O7: insert、insertBulk、save對繼承/自有不可列舉之id, 於autoGenPk為true補新主鍵、為false依「未帶」拒絕; 以陣列與單一物件兩種形式給列
            for (let api of ['insert', 'insertBulk', 'save']) {
                for (let sh of shapes) {
                    for (let collide of ((sh.inhStr || sh.collidable) ? [false, true] : [false])) {
                        for (let asArray of [true, false]) {
                            it(`${api}: ${sh.name}${collide ? ', existing row with same value' : ''}${asArray ? '' : ' (single object)'}`, async function() {
                                let t = mk({ autoGenPk })
                                let k = uniq()
                                let idv = `inh-${k}`
                                let nm = `row-${k}`
                                let before = await seed(t, idv, collide, sh.extraIds ? sh.extraIds(idv) : [])
                                let rej = null
                                let r = null
                                try {
                                    let row = sh.make(idv, nm)
                                    r = await t.wo[api](asArray ? [row] : row)
                                }
                                catch (err) {
                                    rej = err
                                }
                                if (autoGenPk) {
                                    assert.ok(rej === null, `must resolve, rejected ${rej === null ? '' : msgOf(rej)}`)

                                    //O2: 回傳為一筆新插入
                                    if (api === 'save') {
                                        assert.deepStrictEqual(r, [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }])
                                    }
                                    else {
                                        assert.deepStrictEqual(r, { n: 1, nInserted: 1, ok: 1 })
                                    }

                                    //O2: 既有列(含與繼承值同id者)原樣, 另多出一筆帶新主鍵之列
                                    let after = await rows(t)
                                    let ids0 = new Set(before.map((v) => v.id))
                                    assert.strictEqual(after.length, before.length + 1)
                                    for (let v of before) {
                                        assert.deepStrictEqual(after.find((x) => x.id === v.id), v)
                                    }
                                    let added = after.filter((v) => !ids0.has(v.id))
                                    assert.strictEqual(added.length, 1)
                                    assert.ok(reUuid.test(added[0].id), `id must be generated, got ${JSON.stringify(added[0].id)}`)
                                    assert.notStrictEqual(added[0].id, idv)
                                    assert.strictEqual(added[0].name, nm)
                                    assert.deepStrictEqual(Object.keys(added[0]).sort(), ['id', 'name']) //O7: 只含自有可列舉之欄位
                                    assert.strictEqual(nType(t.evs, 'error'), 0)
                                    chkKeyIsId(await raw(t))
                                }
                                else {

                                    //O3: 依「未帶」之既有拒絕, 整批reject, 不寫入
                                    let msg = `can not ${api} by data[0] without valid id when autoGenPk is false`
                                    assert.strictEqual(rej === null ? `resolved ${JSON.stringify(r)}` : msgOf(rej), msg)
                                    assert.deepStrictEqual(await rows(t), before)
                                    assert.strictEqual(nType(t.evs, 'error', api), 1)
                                    assert.strictEqual(t.evs[0].err, msg)
                                    assert.strictEqual(nType(t.evs, 'change'), 0)
                                    chkKeyIsId(await raw(t))
                                }
                            })
                        }
                    }
                }
            }

            //O2、O3: 批次內之索引與混合(自有者原樣、繼承者補值, 順序保持); 同批相同之繼承值不互相衝突
            for (let api of ['insert', 'insertBulk', 'save']) {
                it(`${api}: batch mixing own and inherited ids keeps order`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let idv = `inh-${k}`
                    let data = [
                        { id: `own-a-${k}`, name: `a-${k}` },
                        Object.assign(Object.create({ id: idv }), { name: `b-${k}` }),
                        { id: `own-c-${k}`, name: `c-${k}` },
                        Object.assign(Object.create({ id: idv }), { name: `d-${k}` }),
                    ]
                    let rej = null
                    try {
                        await t.wo[api](data)
                    }
                    catch (err) {
                        rej = err
                    }
                    if (autoGenPk) {
                        assert.ok(rej === null, `must resolve, rejected ${rej === null ? '' : msgOf(rej)}`)
                        let after = await rows(t)
                        assert.strictEqual(after.length, 4)
                        let by = (nm) => after.find((v) => v.name === nm)
                        assert.strictEqual(by(`a-${k}`).id, `own-a-${k}`)
                        assert.strictEqual(by(`c-${k}`).id, `own-c-${k}`)
                        assert.ok(reUuid.test(by(`b-${k}`).id) && reUuid.test(by(`d-${k}`).id))
                        assert.notStrictEqual(by(`b-${k}`).id, by(`d-${k}`).id) //同批相同之繼承值不得互相衝突, 各得新主鍵
                        chkKeyIsId(await raw(t))
                    }
                    else {

                        //索引為第一筆未帶者(data[1])
                        assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), `can not ${api} by data[1] without valid id when autoGenPk is false`)
                        assert.deepStrictEqual(await rows(t), [])
                        assert.strictEqual(nType(t.evs, 'error', api), 1)
                    }
                })
            }

            //O4: del對繼承之id視為未給, 同值之既有列不被刪除(不論autoGenPk)
            for (let sh of shapes) {
                for (let collide of ((sh.inhStr || sh.collidable) ? [false, true] : [false])) {
                    it(`del: ${sh.name}${collide ? ', existing row with same value' : ''}`, async function() {
                        let t = mk({ autoGenPk })
                        let k = uniq()
                        let idv = `inh-${k}`
                        let before = await seed(t, idv, collide, sh.extraIds ? sh.extraIds(idv) : [])
                        let r = await t.wo.del([sh.make(idv, `row-${k}`)])
                        assert.deepStrictEqual(r, [{ n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' }])
                        assert.deepStrictEqual(await rows(t), before) //既有列(含與繼承值同id者)皆在
                        assert.strictEqual(nType(t.evs, 'error', 'del'), 1)
                        assert.strictEqual(nType(t.evs, 'change', 'del'), 1) //逐筆失敗之整批仍resolve並發change(既有)
                        chkKeyIsId(await raw(t))
                    })
                }
            }

        })
    }

    describe('controls: own enumerable id unchanged (O6)', function() {

        for (let autoGenPk of [true, false]) {
            for (let api of ['insert', 'insertBulk', 'save']) {
                it(`${api}: own string id stored as given (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    await t.wo[api]([{ id: `own-${k}`, name: `n-${k}` }])
                    assert.deepStrictEqual(await rows(t), [{ id: `own-${k}`, name: `n-${k}` }])
                    chkKeyIsId(await raw(t))
                })

                it(`${api}: own id shadowing an inherited id is stored (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let row = Object.assign(Object.create({ id: `inh-${k}` }), { id: `own-${k}`, name: `n-${k}` })
                    await t.wo[api]([row])
                    assert.deepStrictEqual(await rows(t), [{ id: `own-${k}`, name: `n-${k}` }])
                    chkKeyIsId(await raw(t))
                })

                it(`${api}: own accessor id is copied as a data property (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let row = { name: `n-${k}` }
                    Object.defineProperty(row, 'id', {
                        get() {
                            return `acc-${k}`
                        },
                        enumerable: true,
                        configurable: true,
                    })
                    await t.wo[api]([row])
                    assert.deepStrictEqual(await rows(t), [{ name: `n-${k}`, id: `acc-${k}` }])
                    chkKeyIsId(await raw(t))
                })
            }

            it(`del: own string id deletes the row, even when a different id is inherited (autoGenPk: ${autoGenPk})`, async function() {
                let t = mk({ autoGenPk })
                let k = uniq()
                await t.wo.insert({ id: `own-${k}`, name: `n-${k}` })
                await t.wo.insert({ id: `keep-${k}`, name: `keep-${k}` })
                let row = Object.assign(Object.create({ id: `inh-${k}` }), { id: `own-${k}` }) //自有遮蔽繼承
                let r = await t.wo.del([row])
                assert.deepStrictEqual(r, [{ n: 1, nDeleted: 1, ok: 1 }])
                assert.deepStrictEqual((await rows(t)).map((v) => v.id), [`keep-${k}`])
            })
        }

        //O4 不變者: 繼承之空字串、數字(非有效主鍵)照原訊息, 不因改動而變
        it('del: inherited empty string keeps its message (string is empty)', async function() {
            let t = mk()
            let k = uniq()
            let r = await t.wo.del([Object.assign(Object.create({ id: '' }), { name: `n-${k}` })])
            assert.deepStrictEqual(r, [{ n: 0, nDeleted: 0, ok: 0, err: 'invalid id: string is empty at [data[0].id]' }])
        })
        it('del: inherited number keeps its message (not a string)', async function() {
            let t = mk()
            let k = uniq()
            let r = await t.wo.del([Object.assign(Object.create({ id: 123 }), { name: `n-${k}` })])
            assert.deepStrictEqual(r, [{ n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' }])
        })

        //O4: 繼承之有效字串不送進後端查詢(getMany之鍵清單不含它)
        it('del: an inherited string id is not sent to the backend lookup, an own one is', async function() {
            let t = mk()
            let k = uniq()
            await t.wo.insert({ id: `own-${k}`, name: `n-${k}` })
            await t.wo.insert({ id: `inh-${k}`, name: `same-value-${k}` })
            let seen = []
            let own = Object.getOwnPropertyDescriptor(Level.prototype, 'getMany')
            let orig = Level.prototype.getMany
            Object.defineProperty(Level.prototype, 'getMany', {
                value: function(keys, ...args) {
                    seen.push(...keys)
                    return orig.call(this, keys, ...args)
                },
                configurable: true,
                writable: true,
            })
            let r = null
            try {
                r = await t.wo.del([Object.assign(Object.create({ id: `inh-${k}` }), { name: `n-${k}` }), { id: `own-${k}` }])
            }
            finally {
                if (own !== undefined) {
                    Object.defineProperty(Level.prototype, 'getMany', own)
                }
                else {
                    delete Level.prototype.getMany
                }
            }
            assert.deepStrictEqual(seen, [`own-${k}`])
            assert.deepStrictEqual(r, [{ n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' }, { n: 1, nDeleted: 1, ok: 1 }])
            assert.deepStrictEqual(await rows(t), [{ id: `inh-${k}`, name: `same-value-${k}` }])
        })

        //O4: 批次中之索引(k大於0)與混合: 繼承同值列(索引0)、自有存在列(1)、自有不存在列(2)、繼承數字(3)、自有存在列之重複(4); 逐筆結果與庫內皆依序
        it('del: a mixed batch reports per item with the batch index and leaves the same-valued row alone', async function() {
            let t = mk()
            let k = uniq()
            await t.wo.insert({ id: `inh-${k}`, name: `same-value-${k}` })
            await t.wo.insert({ id: `own-${k}`, name: `own-${k}` })
            await t.wo.insert({ id: `keep-${k}`, name: `keep-${k}` })
            let r = await t.wo.del([
                Object.assign(Object.create({ id: `inh-${k}` }), { name: `row0-${k}` }),
                { id: `own-${k}` },
                { id: `none-${k}` },
                Object.assign(Object.create({ id: 5000 + k }), { name: `row3-${k}` }),
                { id: `own-${k}` },
            ])
            assert.deepStrictEqual(r, [
                { n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' },
                { n: 1, nDeleted: 1, ok: 1 },
                { n: 0, nDeleted: 0, ok: 1 },
                { n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[3].id]' },
                { n: 0, nDeleted: 0, ok: 1 },
            ])
            assert.deepStrictEqual((await rows(t)).map((v) => v.id).sort(), [`inh-${k}`, `keep-${k}`].sort())
        })

        //O6: 自有可列舉之id遇庫內同值之既有列: 行為不變(insert跳過、insertBulk整批reject、save合併更新、del刪除), 不論autoGenPk
        for (let autoGenPk of [true, false]) {
            it(`own enumerable id with an existing same-valued row behaves as before: insert skips, insertBulk rejects, save merges (autoGenPk: ${autoGenPk})`, async function() {
                let t = mk({ autoGenPk })
                let k = uniq()
                await t.wo.insert({ id: `own-${k}`, name: `orig-${k}`, v: 1 })
                t.evs.length = 0
                assert.deepStrictEqual(await t.wo.insert([{ id: `own-${k}`, name: `ins-${k}` }]), { n: 1, nInserted: 0, ok: 1 })
                assert.deepStrictEqual(await rows(t), [{ id: `own-${k}`, name: `orig-${k}`, v: 1 }])
                let rej = null
                try {
                    await t.wo.insertBulk([{ id: `own-${k}`, name: `bulk-${k}` }])
                }
                catch (err) {
                    rej = err
                }
                assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), `can not insertBulk by existed id[own-${k}]`)
                assert.deepStrictEqual(await rows(t), [{ id: `own-${k}`, name: `orig-${k}`, v: 1 }])
                assert.deepStrictEqual(await t.wo.save([{ id: `own-${k}`, name: `saved-${k}` }]), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
                assert.deepStrictEqual(await rows(t), [{ id: `own-${k}`, name: `saved-${k}`, v: 1 }])
                assert.deepStrictEqual(await t.wo.del([{ id: `own-${k}` }]), [{ n: 1, nDeleted: 1, ok: 1 }])
                assert.deepStrictEqual(await rows(t), [])
            })
        }

        //O1、O2: 陣列內之列其鍵全在原型上(單一物件時為輸入無效早退, 陣列內則進procPk): 視為未帶, autoGenPk為true寫入僅含新主鍵之列(繼承之name不存入), 為false整批reject
        for (let autoGenPk of [true, false]) {
            for (let api of ['insert', 'insertBulk', 'save']) {
                it(`${api}: an array row whose keys are all inherited is a not-given id (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let rej = null
                    try {
                        await t.wo[api]([Object.create({ id: `inh-${k}`, name: `n-${k}` })])
                    }
                    catch (err) {
                        rej = err
                    }
                    if (autoGenPk) {
                        assert.ok(rej === null, `must resolve, rejected ${rej === null ? '' : msgOf(rej)}`)
                        let after = await rows(t)
                        assert.strictEqual(after.length, 1)
                        assert.deepStrictEqual(Object.keys(after[0]), ['id'])
                        assert.ok(reUuid.test(after[0].id))
                        chkKeyIsId(await raw(t))
                    }
                    else {
                        assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), `can not ${api} by data[0] without valid id when autoGenPk is false`)
                        assert.deepStrictEqual(await rows(t), [])
                    }
                })
            }
        }

        //O7: 繼承之可列舉非id欄位不存入(insert、insertBulk、save之插入路徑; 規則範圍外之既有處置, 非主鍵欄之繼承欄位不變)
        for (let api of ['insert', 'insertBulk', 'save']) {
            it(`${api}: inherited enumerable non-id field is not stored`, async function() {
                let t = mk()
                let k = uniq()
                let row = Object.assign(Object.create({ extra: `INH-${k}` }), { id: `own-${k}`, name: `n-${k}` })
                await t.wo[api]([row])
                assert.deepStrictEqual(await rows(t), [{ id: `own-${k}`, name: `n-${k}` }])
            })
        }

        //對照(既有契約不變): 單一物件而全部鍵皆在原型上(無任何自有可列舉鍵)者為輸入無效(wsemi iseobj為false), insert/insertBulk回n為0、save/del回[], 不寫入、不發事件
        it('a bare object whose keys are all inherited is invalid input (early return, nothing written)', async function() {
            let t = mk()
            let k = uniq()
            await t.wo.insert({ id: `seed-${k}`, name: `seed-${k}` })
            let before = await rows(t)
            t.evs.length = 0
            let row = () => Object.create({ id: `inh-${k}`, name: `n-${k}` })
            assert.deepStrictEqual(await t.wo.insert(row()), { n: 0, nInserted: 0, ok: 1 })
            assert.deepStrictEqual(await t.wo.insertBulk(row()), { n: 0, nInserted: 0, ok: 1 })
            assert.deepStrictEqual(await t.wo.save(row()), [])
            assert.deepStrictEqual(await t.wo.del(row()), [])
            assert.deepStrictEqual(await rows(t), before)
            assert.strictEqual(t.evs.length, 0)
        })

        //O5: selectByPk收純量pk; 傳入物件(帶繼承id)回null且不發事件; 純量pk照常
        it('selectByPk: object carrying an inherited id returns null without events; plain pk still works', async function() {
            let t = mk()
            let k = uniq()
            await t.wo.insert({ id: `inh-${k}`, name: `seed-${k}` })
            t.evs.length = 0
            let r = await t.wo.selectByPk(Object.assign(Object.create({ id: `inh-${k}` }), { name: 'n' }))
            assert.strictEqual(r, null)
            assert.strictEqual(t.evs.length, 0)
            assert.deepStrictEqual(await t.wo.selectByPk(`inh-${k}`), { id: `inh-${k}`, name: `seed-${k}` })
        })

    })

    //O8: 判定不多讀有效輸入
    describe('read counts (O8)', function() {
        for (let autoGenPk of [true, false]) {
            for (let api of ['insert', 'insertBulk', 'save', 'del']) {
                it(`${api}: own accessor id getter is read exactly once (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let cnt = 0
                    let row = { name: `n-${k}` }
                    Object.defineProperty(row, 'id', {
                        get() {
                            cnt++
                            return `acc-${k}`
                        },
                        enumerable: true,
                        configurable: true,
                    })
                    await t.wo[api]([row])
                    assert.strictEqual(cnt, 1)
                })

                it(`${api}: inherited accessor id getter is read ${api === 'del' ? 'twice (existing: batch key collection + per item)' : 'exactly once'} (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let cnt = 0
                    class C {
                        get id() {
                            cnt++
                            return `inh-${k}`
                        }
                    }
                    let row = new C()
                    row.name = `n-${k}`
                    let rej = null
                    try {
                        await t.wo[api]([row])
                    }
                    catch (err) {
                        rej = err
                    }

                    //通道: autoGenPk為false時insert類入口依「未帶」reject(讀取次數仍須相同), 其餘resolve
                    assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), (autoGenPk || api === 'del') ? 'resolved' : `can not ${api} by data[0] without valid id when autoGenPk is false`)
                    assert.strictEqual(cnt, api === 'del' ? 2 : 1)
                })
            }
        }
    })

    //O9: 補主鍵不經賦值, 原型上之setter不被執行
    describe('the generated id is defined, not assigned (O9)', function() {
        for (let api of ['insert', 'insertBulk', 'save']) {
            it(`${api}: a setter on the prototype is never run, the row is stored with a generated id`, async function() {
                let t = mk()
                let k = uniq()
                let nSet = 0
                class S {
                    get id() {
                        return undefined
                    }

                    set id(v) {
                        nSet++
                        throw new Error(`setter-boom-${k}`)
                    }
                }
                let row = new S()
                row.name = `n-${k}`
                let r = await t.wo[api]([row])
                assert.ok(r !== null)
                assert.strictEqual(nSet, 0)
                let after = await rows(t)
                assert.strictEqual(after.length, 1)
                assert.ok(reUuid.test(after[0].id))
                assert.strictEqual(after[0].name, `n-${k}`)
                chkKeyIsId(await raw(t))
            })
        }
    })

    //O11: cloneDeep不複製陣列內之函數(原樣交出同一參考), Proxy包裝之函數列其getOwnPropertyDescriptor陷阱會執行呼叫端之程式(查描述子時),
    //拋錯者轉固定詞彙invalid data: must be a readable value(口徑A2), 不轉出拋出者之文字, error事件之data為null, 資料庫不變; insert、insertBulk、save為整批reject, del整批取鍵時即拋(整批reject)
    describe('a function row whose descriptor trap throws is rejected with the fixed message (O11)', function() {
        let mkFnRow = () => new Proxy(function() {}, {
            get(t, key) {
                return key === 'id' ? 'x' : undefined
            },
            getOwnPropertyDescriptor() {
                throw new Error('gopd-boom-SECRET')
            },
        })
        for (let autoGenPk of [true, false]) {
            for (let api of ['insert', 'insertBulk', 'save', 'del']) {
                it(`${api}: rejects the whole batch with invalid data, the thrower's text is not echoed, error event data is null, database unchanged (autoGenPk: ${autoGenPk})`, async function() {
                    let t = mk({ autoGenPk })
                    let k = uniq()
                    let before = await seed(t, `inh-${k}`, false)
                    let rej = null
                    try {
                        await t.wo[api]([mkFnRow()])
                    }
                    catch (err) {
                        rej = err
                    }
                    assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), 'invalid data: must be a readable value')
                    assert.ok(!/SECRET|boom/.test(msgOf(rej)))
                    let evErr = t.evs.filter((v) => v.type === 'error')
                    assert.strictEqual(evErr.length, 1)
                    assert.strictEqual(evErr[0].mode, api)
                    assert.strictEqual(evErr[0].err, 'invalid data: must be a readable value')
                    assert.ok(evErr[0].data === null, 'error event data is null')
                    assert.strictEqual(nType(t.evs, 'change'), 0)
                    assert.deepStrictEqual(await rows(t), before)
                })
            }
        }
    })

    //O2、O10(短路): 值為未帶者不查描述子(取值先於查描述子)——以Proxy函數列(cloneDeep不複製, 其getOwnPropertyDescriptor陷阱拋錯)為載體:
    //autoGenPk為false且id未帶者, procPk於取值後即以「未帶」拒絕(訊息without valid id), 不得先查描述子而轉成invalid data;
    //del之id為無效值(數字)者, 整批取鍵與逐筆皆免查描述子, 該筆為not a string, 不得轉成invalid data
    describe('a not-given or invalid value short-circuits before the descriptor is queried (O2)', function() {
        let mkFnRow = (idv) => new Proxy(function() {}, {
            get(t, key) {
                return key === 'id' ? idv : undefined
            },
            getOwnPropertyDescriptor() {
                throw new Error('gopd-boom-SECRET')
            },
        })
        for (let api of ['insert', 'insertBulk', 'save']) {
            it(`${api}: autoGenPk false, id read as undefined: rejected as not given without querying the descriptor`, async function() {
                let t = mk({ autoGenPk: false })
                let rej = null
                try {
                    await t.wo[api]([mkFnRow(undefined)])
                }
                catch (err) {
                    rej = err
                }
                assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), `can not ${api} by data[0] without valid id when autoGenPk is false`)
            })
        }
        it('del: id read as a number: the item fails as not a string without querying the descriptor', async function() {
            let t = mk()
            let r = await t.wo.del([mkFnRow(123)])
            assert.deepStrictEqual(r, [{ n: 0, nDeleted: 0, ok: 0, err: 'invalid id: not a string at [data[0].id]' }])
        })
    })

    //O1(自有不可列舉): cloneDeep會剝除資料列之自有不可列舉屬性, 唯不複製陣列內之函數(原樣交出), 其自有不可列舉之id為複本上唯一仍會出現者:
    //視為未帶(autoGenPk為false時整批reject於without valid id; 若改以hasOwnProperty判定則被當成給了), 以此釘住「可列舉」之判準
    describe('an own non-enumerable id on a function row is a not-given id (O1)', function() {
        for (let api of ['insert', 'insertBulk', 'save']) {
            it(`${api}: autoGenPk false rejects as not given`, async function() {
                let t = mk({ autoGenPk: false })
                let k = uniq()
                let fn = Object.defineProperty(function() {}, 'id', { value: `fn-${k}`, enumerable: false, configurable: true })
                let rej = null
                try {
                    await t.wo[api]([fn])
                }
                catch (err) {
                    rej = err
                }
                assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), `can not ${api} by data[0] without valid id when autoGenPk is false`)
            })
        }
    })

    //O10: 非物件之列(字串、數字; null與undefined為輸入無效之早退, 不進procPk)維持既有之原生TypeError(補值賦值於非物件)與整批性之「未帶」拒絕
    describe('non-object rows keep their native behaviour (O10)', function() {
        for (let api of ['insert', 'insertBulk', 'save']) {
            for (let [name, mkRow, re] of [
                ['string', () => 'abc', /Cannot create property 'id' on string/],
                ['number', () => 5, /Cannot create property 'id' on number/],
            ]) {
                it(`${api}: a ${name} row keeps its native TypeError (autoGenPk true)`, async function() {
                    let t = mk()
                    let rej = null
                    try {
                        await t.wo[api]([mkRow()])
                    }
                    catch (err) {
                        rej = err
                    }
                    assert.ok(rej instanceof TypeError, `got ${rej === null ? 'resolved' : msgOf(rej)}`)
                    assert.ok(re.test(rej.message), rej.message)
                    assert.deepStrictEqual(await rows(t), [])
                })

                it(`${api}: a ${name} row is a not-given id (autoGenPk false)`, async function() {
                    let t = mk({ autoGenPk: false })
                    let rej = null
                    try {
                        await t.wo[api]([mkRow()])
                    }
                    catch (err) {
                        rej = err
                    }
                    assert.strictEqual(rej === null ? 'resolved' : msgOf(rej), `can not ${api} by data[0] without valid id when autoGenPk is false`)
                })
            }
        }
    })

})
