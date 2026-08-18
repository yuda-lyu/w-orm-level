import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('insertBulk', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_insertbulk')

        let wo = WOrm({ url: './_db_insertbulk', db: 'worm', cl: 'users' })

        //輸入無效, 回傳空結果而非錯誤, 且鍵集合與insert完全相同
        vget[1] = await wo.insertBulk(null)

        //正常插入, nInserted須恆等於n
        rt = null
        await wo.insertBulk([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
            .then(function(msg) {
                rt = msg
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[2] = rt
        vget[3] = _.map(_.sortBy(await wo.select(), 'id'), 'id')

        //單一物件亦須回傳單一物件而非陣列
        vget[4] = await wo.insertBulk({ id: 'd' })

        //含既有主鍵須整批reject, 且不得寫入任何一筆
        let n1 = _.size(await wo.select())
        rt = null
        await wo.insertBulk([{ id: 'e' }, { id: 'a' }, { id: 'f' }])
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[5] = rt
        let n2 = _.size(await wo.select())
        vget[6] = n2 - n1
        vget[7] = [await wo.selectByPk('e'), await wo.selectByPk('f')]

        //同批含重複主鍵須整批reject, 且不得寫入任何一筆
        rt = null
        await wo.insertBulk([{ id: 'g' }, { id: 'h' }, { id: 'g' }])
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[8] = rt
        vget[9] = _.size(await wo.select()) - n2
        vget[10] = [await wo.selectByPk('g'), await wo.selectByPk('h')]

        //大批次末筆衝突亦不得留下部份寫入
        let n3 = _.size(await wo.select())
        let dt = _.map(_.range(200), function(v) {
            return { id: `bulk-${v}` }
        })
        dt.push({ id: 'a' })
        rt = null
        await wo.insertBulk(dt)
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[11] = rt
        vget[12] = _.size(await wo.select()) - n3

        //衝突後既有數據不得被改動
        vget[13] = await wo.selectByPk('a')

        //無衝突之大批次須全數寫入
        vget[14] = await wo.insertBulk(_.map(_.range(200), function(v) {
            return { id: `ok-${v}`, v }
        }))
        vget[15] = _.size(await wo.select()) - n3

        //autoGenPk為true時未帶主鍵者由套件補值
        let r = await wo.insertBulk([{ name: 'auto1' }, { name: 'auto2' }])
        vget[16] = r
        vget[17] = _.size(_.filter(await wo.select(), function(v) {
            return _.startsWith(v.name, 'auto')
        }))

        //本函數非insert之別名: 同一輸入下insert為跳過既有主鍵而整批ok為1, 本函數則整批reject
        let woX = WOrm({ url: './_db_insertbulk', db: 'worm', cl: 'diff' })
        await woX.insert([{ id: 'x1' }])
        let ri = await woX.insert([{ id: 'x1' }, { id: 'x2' }])
        rt = null
        await woX.insertBulk([{ id: 'x1' }, { id: 'x3' }])
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[18] = [ri, rt]
        vget[19] = _.map(_.sortBy(await woX.select(), 'id'), 'id')
        await woX.close()

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_insertbulk')
    })

    vans[1] = { n: 0, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for insertBulk(null)`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 3, nInserted: 3, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for insertBulk 3 rows`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = ['a', 'b', 'c']
    it(`should get ${JSON.stringify(vans[3])} for all ids after insertBulk`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = { n: 1, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[4])} for insertBulk single object`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = 'reject'
    it(`should get ${JSON.stringify(vans[5])} for insertBulk with existed pk`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 0
    it(`should get ${JSON.stringify(vans[6])} for increment of rows after conflict`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = [null, null]
    it(`should get ${JSON.stringify(vans[7])} for rows before and after the conflicted one`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = 'reject'
    it(`should get ${JSON.stringify(vans[8])} for insertBulk with duplicated pk in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = 0
    it(`should get ${JSON.stringify(vans[9])} for increment of rows after duplicated pk`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = [null, null]
    it(`should get ${JSON.stringify(vans[10])} for rows of duplicated batch`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = 'reject'
    it(`should get ${JSON.stringify(vans[11])} for insertBulk 201 rows with conflict at last`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = 0
    it(`should get ${JSON.stringify(vans[12])} for increment of rows after large batch conflict`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = { id: 'a' }
    it(`should get ${JSON.stringify(vans[13])} for existed row after conflict`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = { n: 200, nInserted: 200, ok: 1 }
    it(`should get ${JSON.stringify(vans[14])} for insertBulk 200 rows without conflict`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = 200
    it(`should get ${JSON.stringify(vans[15])} for increment of rows after large batch success`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

    vans[16] = { n: 2, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[16])} for insertBulk without pk when autoGenPk=true`, async function() {
        assert.strict.deepStrictEqual(vget[16], vans[16])
    })

    vans[17] = 2
    it(`should get ${JSON.stringify(vans[17])} for count of auto generated pk rows`, async function() {
        assert.strict.deepStrictEqual(vget[17], vans[17])
    })

    vans[18] = [{ n: 2, nInserted: 1, ok: 1 }, 'reject']
    it(`should get ${JSON.stringify(vans[18])} for different conflict policy between insert and insertBulk`, async function() {
        assert.strict.deepStrictEqual(vget[18], vans[18])
    })

    vans[19] = ['x1', 'x2']
    it(`should get ${JSON.stringify(vans[19])} for all ids after different conflict policy`, async function() {
        assert.strict.deepStrictEqual(vget[19], vans[19])
    })

})
