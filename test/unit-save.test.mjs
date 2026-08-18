import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('save', function() {
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_save')

        let wo = WOrm({ url: './_db_save', db: 'worm', cl: 'users' })

        //輸入無效, 回傳空陣列
        vget[1] = await wo.save(null)
        vget[2] = await wo.save([])

        //既有數據
        await wo.insert([
            { id: 'a', name: 'peter', value: 123, ext: { x: 1, y: 2 } },
            { id: 'b', name: 'rosemary', value: 456 },
        ])

        //主鍵存在, 合併後內容有變更
        vget[3] = await wo.save({ id: 'a', name: 'peter(modify)' })
        vget[4] = await wo.selectByPk('a')

        //主鍵存在, 合併後內容與現值相同而未寫入(整筆相同)
        vget[5] = await wo.save({ id: 'a', name: 'peter(modify)', value: 123, ext: { x: 1, y: 2 } })

        //主鍵存在, 只給部份欄位且值皆與現值相同, 合併結果等於現值故nModified為0
        vget[6] = await wo.save({ id: 'a', value: 123 })

        //主鍵存在, 只給部份欄位且值不同, 未給之欄位須保留
        vget[7] = await wo.save({ id: 'a', value: 999 })
        vget[8] = await wo.selectByPk('a')

        //深層合併: 巢狀物件僅給部份鍵時, 其餘鍵須保留
        vget[9] = await wo.save({ id: 'a', ext: { x: 9 } })
        vget[10] = await wo.selectByPk('a')

        //深層合併後與現值相同者, nModified為0
        vget[11] = await wo.save({ id: 'a', ext: { y: 2 } })

        //主鍵不存在, autoInsert預設為true則插入
        vget[12] = await wo.save({ id: 'c', name: 'kettle' })
        vget[13] = await wo.selectByPk('c')

        //主鍵不存在, autoInsert為false則不插入且n為0
        vget[14] = await wo.save({ id: 'd', name: 'nobody' }, { autoInsert: false })
        vget[15] = await wo.selectByPk('d')

        //單一物件亦回傳長度為1之陣列
        vget[16] = _.isArray(vget[12]) && _.size(vget[12]) === 1

        //逐筆結果之鍵集合恆為{n, nInserted, nModified, ok}
        let rs = await wo.save([
            { id: 'a', value: 1000 }, //更新
            { id: 'b', value: 456 }, //內容相同
            { id: 'e', value: 1 }, //插入
        ])
        vget[17] = rs
        vget[18] = _.uniq(_.map(rs, function(v) {
            return _.keys(v).sort().join(',')
        }))

        //與輸入等長保序
        vget[19] = _.size(rs)

        //autoGenPk為true時未帶主鍵者由套件補值後插入
        let ra = await wo.save({ name: 'auto' })
        vget[20] = ra
        vget[21] = _.size(_.filter(await wo.select(), function(v) {
            return v.name === 'auto'
        }))

        //單一行程內併發save同一列之不同欄位, 由序列化佇列保證不遺失更新
        let woP = WOrm({ url: './_db_save', db: 'worm', cl: 'para' })
        await woP.insert({ id: 'p1' })
        await Promise.all(_.map(_.range(20), function(k) {
            return woP.save({ id: 'p1', [`k${k}`]: k })
        }))
        let vp = await woP.selectByPk('p1')
        vget[22] = _.size(_.keys(vp)) //id加20個欄位
        await woP.close()

        //註: save之逐筆失敗路徑(ok為0)於本套件不可達, 因逐筆處理皆為記憶體內之比對與合併而不拋錯,
        //批次取值與批次寫入之失敗影響全部筆數而屬整批性錯誤, 依規格以reject回報而不降為逐筆
        //[單筆失敗不中斷整批]之可達情形見unit-del之未帶有效主鍵

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_save')
    })

    vans[1] = []
    it(`should get ${JSON.stringify(vans[1])} for save(null)`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = []
    it(`should get ${JSON.stringify(vans[2])} for save([])`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[3])} for save with modified content`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = { id: 'a', name: 'peter(modify)', value: 123, ext: { x: 1, y: 2 } }
    it(`should get ${JSON.stringify(vans[4])} for row after save`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[5])} for save with same content`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[6])} for save with partial fields and same values`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[7])} for save with partial fields and different values`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = { id: 'a', name: 'peter(modify)', value: 999, ext: { x: 1, y: 2 } }
    it(`should get ${JSON.stringify(vans[8])} for row keeping fields which not given`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = [{ n: 1, nInserted: 0, nModified: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[9])} for save with partial keys of nested object`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = { id: 'a', name: 'peter(modify)', value: 999, ext: { x: 9, y: 2 } }
    it(`should get ${JSON.stringify(vans[10])} for row after deep merge`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = [{ n: 1, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[11])} for save with nested object and same values`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[12])} for save with autoInsert=true and pk not existed`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = { id: 'c', name: 'kettle' }
    it(`should get ${JSON.stringify(vans[13])} for row inserted by save`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = [{ n: 0, nInserted: 0, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[14])} for save with autoInsert=false and pk not existed`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = null
    it(`should get ${JSON.stringify(vans[15])} for row not inserted by save with autoInsert=false`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

    vans[16] = true
    it(`should get ${JSON.stringify(vans[16])} for save single object returning array with length 1`, async function() {
        assert.strict.deepStrictEqual(vget[16], vans[16])
    })

    vans[17] = [
        { n: 1, nInserted: 0, nModified: 1, ok: 1 },
        { n: 1, nInserted: 0, nModified: 0, ok: 1 },
        { n: 1, nInserted: 1, nModified: 0, ok: 1 },
    ]
    it(`should get ${JSON.stringify(vans[17])} for save with mixed cases`, async function() {
        assert.strict.deepStrictEqual(vget[17], vans[17])
    })

    vans[18] = ['n,nInserted,nModified,ok']
    it(`should get ${JSON.stringify(vans[18])} for keys of each item`, async function() {
        assert.strict.deepStrictEqual(vget[18], vans[18])
    })

    vans[19] = 3
    it(`should get ${JSON.stringify(vans[19])} for length of result equal to input`, async function() {
        assert.strict.deepStrictEqual(vget[19], vans[19])
    })

    vans[20] = [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[20])} for save without pk when autoGenPk=true`, async function() {
        assert.strict.deepStrictEqual(vget[20], vans[20])
    })

    vans[21] = 1
    it(`should get ${JSON.stringify(vans[21])} for count of auto generated pk row`, async function() {
        assert.strict.deepStrictEqual(vget[21], vans[21])
    })

    vans[22] = 21
    it(`should get ${JSON.stringify(vans[22])} for keys of row after 20 concurrent saves`, async function() {
        assert.strict.deepStrictEqual(vget[22], vans[22])
    })

})
