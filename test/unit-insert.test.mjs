import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('insert', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_insert')

        let wo = WOrm({ url: './_db_insert', db: 'worm', cl: 'users' })

        //輸入無效, 回傳空結果而非錯誤
        vget[1] = await wo.insert(null)
        vget[2] = await wo.insert('abc')
        vget[3] = await wo.insert([])

        //正常插入
        vget[4] = await wo.insert([{ id: 'a', v: 1 }, { id: 'b', v: 2 }])

        //單一物件亦須回傳單一聚合物件而非陣列
        vget[5] = await wo.insert({ id: 'c', v: 3 })

        //主鍵已存在者跳過且不覆寫, 全數已存在而nInserted為0屬正常結果不得reject
        rt = null
        await wo.insert([{ id: 'a', v: 999 }, { id: 'b', v: 999 }])
            .then(function(msg) {
                rt = msg
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[6] = rt
        vget[7] = await wo.selectByPk('a')

        //部份已存在者, nInserted為實際插入筆數
        vget[8] = await wo.insert([{ id: 'a', v: 999 }, { id: 'd', v: 4 }])

        //同批含重複主鍵時僅首筆計入nInserted, 且資料表不得出現重複主鍵
        vget[9] = await wo.insert([{ id: 'e', v: 1 }, { id: 'e', v: 2 }, { id: 'e', v: 3 }])
        vget[10] = _.size(_.filter(await wo.select(), function(v) {
            return v.id === 'e'
        }))
        vget[11] = await wo.selectByPk('e')

        //全表內容
        vget[12] = _.map(_.sortBy(await wo.select(), 'id'), 'id')

        //單一行程內併發插入同一主鍵, 由序列化佇列保證僅一筆成功
        let ws = await Promise.all(_.map(_.range(20), function() {
            return wo.insert({ id: 'race' })
        }))
        vget[13] = _.sum(_.map(ws, 'nInserted'))
        vget[14] = _.size(_.filter(await wo.select(), function(v) {
            return v.id === 'race'
        }))

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_insert')
    })

    vans[1] = { n: 0, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for insert(null)`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 0, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for insert('abc')`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = { n: 0, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[3])} for insert([])`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = { n: 2, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[4])} for insert 2 rows`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = { n: 1, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[5])} for insert single object`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = { n: 2, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[6])} for insert all existed pk`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = { id: 'a', v: 1 }
    it(`should get ${JSON.stringify(vans[7])} for existed row which not be overwritten`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = { n: 2, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[8])} for insert partial existed pk`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = { n: 3, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[9])} for insert duplicated pk in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = 1
    it(`should get ${JSON.stringify(vans[10])} for count of duplicated pk in table`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = { id: 'e', v: 1 }
    it(`should get ${JSON.stringify(vans[11])} for first row of duplicated pk in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = ['a', 'b', 'c', 'd', 'e']
    it(`should get ${JSON.stringify(vans[12])} for all ids in table`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = 1
    it(`should get ${JSON.stringify(vans[13])} for sum of nInserted by 20 concurrent inserts with same pk`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = 1
    it(`should get ${JSON.stringify(vans[14])} for count of the racing pk in table`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

})
