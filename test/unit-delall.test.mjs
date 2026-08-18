import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('delAll', function() {
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_delall')

        let wo = WOrm({ url: './_db_delall', db: 'worm', cl: 'users' })

        //空表時條件無命中, 回傳{n:0, nDeleted:0, ok:1}而非錯誤
        vget[1] = await wo.delAll()

        //既有數據
        let mkData = async function() {
            await wo.delAll()
            await wo.insert([
                { id: 'a', value: 10 },
                { id: 'b', value: 20 },
                { id: 'c', value: 30 },
                { id: 'd', value: 40 },
                { id: 'e', value: 50 },
            ])
        }
        await mkData()

        //帶條件且僅部份命中, n須為實際刪除筆數而非全表筆數
        vget[2] = await wo.delAll({ value: { '$gte': 40 } })
        vget[3] = _.map(_.sortBy(await wo.select(), 'id'), 'id')

        //條件無命中, 回傳{n:0, nDeleted:0, ok:1}且不得改動數據
        vget[4] = await wo.delAll({ value: { '$gt': 9999 } })
        vget[5] = _.map(_.sortBy(await wo.select(), 'id'), 'id')

        //帶條件且僅命中一筆
        vget[6] = await wo.delAll({ id: 'a' })
        vget[7] = _.map(_.sortBy(await wo.select(), 'id'), 'id')

        //帶條件且全數命中
        await mkData()
        vget[8] = await wo.delAll({ value: { '$gte': 0 } })
        vget[9] = await wo.select()

        //find未給時刪除全部數據
        await mkData()
        vget[10] = await wo.delAll()
        vget[11] = await wo.select()

        //find為空物件時刪除全部數據
        await mkData()
        vget[12] = await wo.delAll({})
        vget[13] = await wo.select()

        //n恆等於nDeleted
        await mkData()
        let r = await wo.delAll({ value: { '$lte': 20 } })
        vget[14] = r.n === r.nDeleted

        //複合條件之命中須與select一致
        await mkData()
        let find = { '$or': [{ value: { '$lte': 10 } }, { value: { '$gte': 50 } }] }
        let ns = _.size(await wo.select(find))
        let rd = await wo.delAll(find)
        vget[15] = [ns, rd.nDeleted]

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_delall')
    })

    vans[1] = { n: 0, nDeleted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for delAll with empty table`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 2, nDeleted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for delAll with partial matched find`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = ['a', 'b', 'c']
    it(`should get ${JSON.stringify(vans[3])} for remaining ids`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = { n: 0, nDeleted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[4])} for delAll with unmatched find`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = ['a', 'b', 'c']
    it(`should get ${JSON.stringify(vans[5])} for remaining ids after unmatched find`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = { n: 1, nDeleted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[6])} for delAll with find matching one row`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = ['b', 'c']
    it(`should get ${JSON.stringify(vans[7])} for remaining ids after deleting one row`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = { n: 5, nDeleted: 5, ok: 1 }
    it(`should get ${JSON.stringify(vans[8])} for delAll with find matching all rows`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = []
    it(`should get ${JSON.stringify(vans[9])} for table after deleting all rows by find`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = { n: 5, nDeleted: 5, ok: 1 }
    it(`should get ${JSON.stringify(vans[10])} for delAll without find`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = []
    it(`should get ${JSON.stringify(vans[11])} for table after delAll without find`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = { n: 5, nDeleted: 5, ok: 1 }
    it(`should get ${JSON.stringify(vans[12])} for delAll with empty find`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = []
    it(`should get ${JSON.stringify(vans[13])} for table after delAll with empty find`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = true
    it(`should get ${JSON.stringify(vans[14])} for n equal to nDeleted`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = [2, 2]
    it(`should get ${JSON.stringify(vans[15])} for count of select and nDeleted with same find`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

})
