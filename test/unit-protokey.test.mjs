import assert from 'assert'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


//主鍵為Object.prototype成員名時之往返(帳本R-PKMAP-01, 排程第66項批1c run02)
//各寫入入口以[主鍵 => 現值]對照表判定主鍵是否已存在, 修前以一般物件加wsemi haskey(即in運算子)判定, 走原型鏈:
//主鍵為constructor、toString、__proto__等時恆被當成已存在, insert回{n:1,nInserted:0,ok:1}而靜默不寫入,
//insertBulk誤報主鍵衝突, save誤報nModified, del誤報nDeleted, 且以__proto__為主鍵之紀錄其欄位名被誤認為他筆主鍵(save時字串被展開為{0:'x'}寫入而損毀資料)
describe('protokey', function() {
    let url = './test/_tmp/protokey'

    //以下為兩套件之差異處(mk、closeWo、before、after), 其後之測試主體兩套件相同(WOrmLowdb版由tmp/gen-lowdb-protokey.mjs自本檔產生)
    //mk: 建立資料庫, name為資料夾名(url), opt可覆寫db與cl
    let mk = (name, opt = {}) => {
        return WOrm({ url: `${url}/${name}`, db: 'worm', cl: 'c', ...opt })
    }

    //closeWo: 關閉資料庫
    let closeWo = async(wo) => {
        await wo.close()
    }

    before(function() {
        w.fsDeleteFolder(url)
    })

    after(function() {
        w.fsDeleteFolder(url)
    })
    //=== 以下兩套件相同 ===

    //use: 建立資料庫並執行fn, 結束一律關閉
    let n = 0
    let use = async(fn, opt = {}) => {
        n++
        let wo = mk(`p${n}`, opt)
        try {
            return await fn(wo)
        }
        finally {
            await closeWo(wo)
        }
    }

    //protoNames, Object.prototype之全部自有屬性名(含__proto__、constructor、toString、hasOwnProperty等共12個)
    let protoNames = Object.getOwnPropertyNames(Object.prototype)

    //ctrlNames, 對照組: 非Object.prototype成員之一般字串, 結果須與修前相同
    let ctrlNames = ['prototype', 'length', 'toJSON', 'then', '__proto', 'proto__', 'id']

    //snap, 資料庫現況(依id升冪)
    let snap = async(wo) => (await wo.select()).sort((a, b) => (a.id < b.id ? -1 : 1))

    //捕捉錯誤訊息
    let rej = async(fn) => {
        try {
            await fn()
        }
        catch (err) {
            return String(err && err.message ? err.message : err)
        }
        return null
    }

    it('protoNames covers all 12 members of Object.prototype', function() {
        assert.strict.equal(protoNames.length, 12)
        assert.strict.ok(protoNames.includes('__proto__'))
        assert.strict.ok(protoNames.includes('constructor'))
        assert.strict.ok(protoNames.includes('hasOwnProperty'))
    })

    for (let group of [{ title: 'proto', ids: protoNames }, { title: 'ctrl', ids: ctrlNames }]) {
        for (let id of group.ids) {
            describe(`${group.title} id=${id}`, function() {

                it('insert: fresh id is written, repeat is skipped without overwrite', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.insert({ id, a: 1 }), { n: 1, nInserted: 1, ok: 1 })
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1 }])
                        assert.strict.deepEqual(await wo.selectByPk(id), { id, a: 1 })
                        assert.strict.deepEqual(await wo.insert({ id, a: 2 }), { n: 1, nInserted: 0, ok: 1 })
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1 }])
                    })
                })

                it('insert returnList: per-row nInserted follows real existence', async function() {
                    await use(async(wo) => {
                        let o = { returnList: true }
                        assert.strict.deepEqual(await wo.insert([{ id, a: 1 }, { id: 'plain', a: 2 }], o), [{ n: 1, nInserted: 1, ok: 1 }, { n: 1, nInserted: 1, ok: 1 }])
                        assert.strict.deepEqual(await wo.insert([{ id, a: 3 }, { id: 'plain2', a: 4 }], o), [{ n: 1, nInserted: 0, ok: 1 }, { n: 1, nInserted: 1, ok: 1 }])
                        assert.strict.deepEqual(await wo.selectByPk(id), { id, a: 1 })
                    })
                })

                it('insertBulk: fresh id succeeds, repeat and same-batch duplicate conflict', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.insertBulk({ id, a: 1 }), { n: 1, nInserted: 1, ok: 1 })
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1 }])
                        assert.strict.equal(await rej(() => wo.insertBulk({ id, a: 2 })), `can not insertBulk by existed id[${id}]`)
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1 }])
                    })
                    await use(async(wo) => {
                        assert.strict.equal(await rej(() => wo.insertBulk([{ id, a: 1 }, { id, a: 2 }])), `can not insertBulk by existed id[${id}]`)
                        assert.strict.deepEqual(await snap(wo), [])
                    })
                })

                it('insertBulk: mixed with an ordinary id in the same batch', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.insertBulk([{ id: 'plain', a: 1 }, { id, a: 2 }]), { n: 2, nInserted: 2, ok: 1 })
                        assert.strict.deepEqual(await wo.selectByPk(id), { id, a: 2 })
                        assert.strict.deepEqual(await wo.selectByPk('plain'), { id: 'plain', a: 1 })
                    })
                })

                it('save: fresh id is inserted and emits the insert event', async function() {
                    await use(async(wo) => {
                        let modes = []
                        wo.on('change', (mode) => modes.push(mode))
                        assert.strict.deepEqual(await wo.save({ id, a: 1 }), [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1 }])
                        assert.strict.deepEqual(modes, ['insert', 'save'])
                    })
                })

                it('save: existing id is merged, identical content is not a modification', async function() {
                    await use(async(wo) => {
                        await wo.save({ id, a: 1 })
                        assert.strict.deepEqual(await wo.save({ id, b: 2 }), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1, b: 2 }])
                        assert.strict.deepEqual(await wo.save({ id, a: 1 }), [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1, b: 2 }])
                    })
                })

                it('save autoInsert:false: absent id is not written, existing id is modified', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.save({ id, a: 1 }, { autoInsert: false }), [{ n: 0, nInserted: 0, nModified: 0, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [])
                        await wo.insert({ id, a: 1 })
                        assert.strict.deepEqual(await wo.save({ id, a: 2 }, { autoInsert: false }), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 2 }])
                    })
                })

                it('save: same id twice in a batch inserts then modifies', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.save([{ id, a: 1 }, { id, b: 2 }]), [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }, { n: 1, nInserted: 0, nModified: 1, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [{ id, a: 1, b: 2 }])
                    })
                })

                it('del: existing id is deleted, repeat deletes nothing', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.insert({ id, a: 1 }), { n: 1, nInserted: 1, ok: 1 })
                        assert.strict.deepEqual(await wo.del({ id }), [{ n: 1, nDeleted: 1, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [])
                        assert.strict.deepEqual(await wo.selectByPk(id), null)
                        assert.strict.deepEqual(await wo.del({ id }), [{ n: 0, nDeleted: 0, ok: 1 }])
                    })
                })

                it('del: absent id reports nothing deleted and leaves other rows', async function() {
                    await use(async(wo) => {
                        await wo.insert({ id: 'keep', a: 1 })
                        assert.strict.deepEqual(await wo.del({ id }), [{ n: 0, nDeleted: 0, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [{ id: 'keep', a: 1 }])
                    })
                })

                it('del: same id twice in a batch deletes once', async function() {
                    await use(async(wo) => {
                        assert.strict.deepEqual(await wo.insert({ id, a: 1 }), { n: 1, nInserted: 1, ok: 1 })
                        assert.strict.deepEqual(await wo.del([{ id }, { id }]), [{ n: 1, nDeleted: 1, ok: 1 }, { n: 0, nDeleted: 0, ok: 1 }])
                        assert.strict.deepEqual(await snap(wo), [])
                    })
                })

                it('selectByPk: absent id is null (table has other rows), present id is the row', async function() {
                    await use(async(wo) => {
                        await wo.insert({ id: 'keep', a: 1 })
                        assert.strict.deepEqual(await wo.selectByPk(id), null)
                        await wo.insert({ id, a: 2 })
                        assert.strict.deepEqual(await wo.selectByPk(id), { id, a: 2 })
                        assert.strict.deepEqual(await wo.selectByPk('keep'), { id: 'keep', a: 1 })
                    })
                })

            })
        }
    }

    describe('all 12 prototype member names in one batch', function() {
        let rows = () => protoNames.map((id, k) => ({ id, a: k }))
        let sorted = () => rows().sort((a, b) => (a.id < b.id ? -1 : 1))

        it('insert', async function() {
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insert(rows()), { n: 12, nInserted: 12, ok: 1 })
                assert.strict.deepEqual(await snap(wo), sorted())
                assert.strict.deepEqual(await wo.insert(rows()), { n: 12, nInserted: 0, ok: 1 })
            })
        })

        it('insertBulk', async function() {
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insertBulk(rows()), { n: 12, nInserted: 12, ok: 1 })
                assert.strict.deepEqual(await snap(wo), sorted())
                assert.strict.equal(await rej(() => wo.insertBulk(rows())), `can not insertBulk by existed id[${protoNames[0]}]`)
            })
        })

        it('save inserts then modifies every row', async function() {
            await use(async(wo) => {
                let ok = (nInserted, nModified) => protoNames.map(() => ({ n: 1, nInserted, nModified, ok: 1 }))
                assert.strict.deepEqual(await wo.save(rows()), ok(1, 0))
                assert.strict.deepEqual(await snap(wo), sorted())
                assert.strict.deepEqual(await wo.save(protoNames.map((id) => ({ id, z: 1 }))), ok(0, 1))
                assert.strict.deepEqual(await snap(wo), sorted().map((v) => ({ ...v, z: 1 })))
            })
        })

        it('del deletes every row', async function() {
            await use(async(wo) => {
                await wo.insertBulk(rows())
                assert.strict.deepEqual(await wo.del(protoNames.map((id) => ({ id }))), protoNames.map(() => ({ n: 1, nDeleted: 1, ok: 1 })))
                assert.strict.deepEqual(await snap(wo), [])
            })
        })
    })

    //交叉污染: 以__proto__為主鍵之紀錄, 其欄位名(name)不得被誤認為他筆之主鍵(修前kp['__proto__']=v改寫對照表之原型)
    describe('field names of a __proto__ row are not primary keys', function() {

        it('insert', async function() {
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insert([{ id: '__proto__', name: 'x' }, { id: 'name' }]), { n: 2, nInserted: 2, ok: 1 })
                assert.strict.deepEqual(await snap(wo), [{ id: '__proto__', name: 'x' }, { id: 'name' }])
            })
        })

        it('insertBulk', async function() {
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insertBulk([{ id: '__proto__', name: 'x' }, { id: 'name' }]), { n: 2, nInserted: 2, ok: 1 })
                assert.strict.deepEqual(await snap(wo), [{ id: '__proto__', name: 'x' }, { id: 'name' }])
            })
        })

        it('save: no corruption of the other row', async function() {
            await use(async(wo) => {
                await wo.insert({ id: '__proto__', name: 'x' })
                assert.strict.deepEqual(
                    await wo.save([{ id: '__proto__', name: 'y' }, { id: 'name', q: 1 }]),
                    [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }, { n: 1, nInserted: 1, nModified: 0, ok: 1 }]
                )
                assert.strict.deepEqual(await snap(wo), [{ id: '__proto__', name: 'y' }, { id: 'name', q: 1 }])
            })
        })

        //row內之欄位名name、k、v(k與v亦為lowdb對照表值{k, v}之欄位名)皆不得被誤認為主鍵
        let row = () => ({ id: '__proto__', name: 'x', k: 1, v: 2 })

        it('selectByPk: names of its fields are absent', async function() {
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insert(row()), { n: 1, nInserted: 1, ok: 1 })
                for (let id of ['name', 'k', 'v']) {
                    assert.strict.equal(await wo.selectByPk(id), null, id)
                }
                assert.strict.deepEqual(await wo.selectByPk('__proto__'), row())
            })
        })

        it('save: names of its fields are inserted as new rows', async function() {
            await use(async(wo) => {
                await wo.insert(row())
                assert.strict.deepEqual(
                    await wo.save([{ id: 'v', a: 1 }, { id: 'k', a: 2 }]),
                    [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }, { n: 1, nInserted: 1, nModified: 0, ok: 1 }]
                )
                assert.strict.deepEqual(await snap(wo), [row(), { id: 'k', a: 2 }, { id: 'v', a: 1 }])
            })
        })

        it('del: names of its fields delete nothing', async function() {
            await use(async(wo) => {
                await wo.insert(row())
                assert.strict.deepEqual(
                    await wo.del([{ id: 'name' }, { id: 'k' }, { id: 'v' }]),
                    [{ n: 0, nDeleted: 0, ok: 1 }, { n: 0, nDeleted: 0, ok: 1 }, { n: 0, nDeleted: 0, ok: 1 }]
                )
                assert.strict.deepEqual(await snap(wo), [row()])
            })
        })

        it('del: only the present row is deleted', async function() {
            await use(async(wo) => {
                await wo.insert({ id: '__proto__', name: 'x' })
                assert.strict.deepEqual(await wo.del([{ id: '__proto__' }, { id: 'name' }]), [{ n: 1, nDeleted: 1, ok: 1 }, { n: 0, nDeleted: 0, ok: 1 }])
                assert.strict.deepEqual(await snap(wo), [])
            })
            await use(async(wo) => {
                await wo.insertBulk([{ id: '__proto__', name: 'x' }, { id: 'name', q: 1 }])
                assert.strict.deepEqual(await wo.del([{ id: '__proto__' }, { id: 'name' }]), [{ n: 1, nDeleted: 1, ok: 1 }, { n: 1, nDeleted: 1, ok: 1 }])
                assert.strict.deepEqual(await snap(wo), [])
            })
        })

    })

    //位址名稱(url、db、cl)為原型成員名者: 其對照表之鍵恆含分隔符或為絕對路徑, 不受影響(帳本R-PKMAP-01之刻意不套站點之佐證)
    describe('address names that are prototype members', function() {

        it('db and cl', async function() {
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insert({ id: 'a', v: 1 }), { n: 1, nInserted: 1, ok: 1 })
                assert.strict.deepEqual(await wo.save({ id: 'a', v: 2 }), [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }])
                assert.strict.deepEqual(await snap(wo), [{ id: 'a', v: 2 }])
            }, { db: 'constructor', cl: '__proto__' })
            await use(async(wo) => {
                assert.strict.deepEqual(await wo.insert({ id: 'a', v: 1 }), { n: 1, nInserted: 1, ok: 1 })
                assert.strict.deepEqual(await snap(wo), [{ id: 'a', v: 1 }])
            }, { db: 'toString', cl: 'hasOwnProperty' })
        })

        it('url named like a prototype member', async function() {
            for (let name of ['constructor', '__proto__']) {
                let wo = mk(name)
                try {
                    assert.strict.deepEqual(await wo.insert({ id: 'a', v: 1 }), { n: 1, nInserted: 1, ok: 1 })
                    assert.strict.deepEqual(await wo.insert({ id: 'a', v: 2 }), { n: 1, nInserted: 0, ok: 1 })
                    assert.strict.deepEqual(await snap(wo), [{ id: 'a', v: 1 }])
                }
                finally {
                    await closeWo(wo)
                }
            }
        })

    })

})
