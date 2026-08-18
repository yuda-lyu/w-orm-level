import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('del', function() {
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_del')

        let wo = WOrm({ url: './_db_del', db: 'worm', cl: 'users' })

        //輸入無效, 回傳空陣列
        vget[1] = await wo.del(null)
        vget[2] = await wo.del([])

        //既有數據
        await wo.insert([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])

        //主鍵命中並刪除
        vget[3] = await wo.del({ id: 'a' })
        vget[4] = await wo.selectByPk('a')

        //主鍵未命中, 屬正常結果故ok為1而n與nDeleted皆為0
        vget[5] = await wo.del({ id: 'not-existed' })

        //該筆未帶有效主鍵, 屬輸入問題故ok為0且必附err
        let r = await wo.del({ name: 'no-id' })
        vget[6] = _.map(r, function(v) {
            return _.omit(v, ['err'])
        })
        vget[7] = w.isestr(_.get(r, '0.err'))
        vget[8] = _.keys(_.get(r, '0')).sort().join(',')

        //單筆失敗不中斷整批: 其餘筆數照常處理, 整批仍resolve
        let rt = null
        await wo.del([{ id: 'b' }, { name: 'no-id' }, { id: 'c' }])
            .then(function(msg) {
                rt = msg
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[9] = _.map(rt, function(v) {
            return _.omit(v, ['err'])
        })
        vget[10] = [await wo.selectByPk('b'), await wo.selectByPk('c')]

        //同批含重複主鍵者, 僅首筆為命中並刪除, 其餘為未命中
        await wo.insert([{ id: 'e' }])
        vget[11] = await wo.del([{ id: 'e' }, { id: 'e' }])
        vget[12] = _.map(_.sortBy(await wo.select(), 'id'), 'id')

        //主鍵未命中者不得以ok分辨不出來: 未命中為ok=1, 未帶有效主鍵為ok=0
        let rm = await wo.del([{ id: 'not-existed' }, { id: '' }])
        vget[13] = _.map(rm, 'ok')

        //del不受autoGenPk影響, 於autoGenPk為true時亦不補值
        let woGen = WOrm({ url: './_db_del', db: 'worm', cl: 'gen', autoGenPk: true })
        await woGen.insert([{ id: 'g1' }])
        let rg = await woGen.del({ name: 'no-id' })
        vget[14] = _.map(rg, 'ok')
        vget[15] = _.map(await woGen.select(), 'id')
        await woGen.close()

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_del')
    })

    vans[1] = []
    it(`should get ${JSON.stringify(vans[1])} for del(null)`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = []
    it(`should get ${JSON.stringify(vans[2])} for del([])`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = [{ n: 1, nDeleted: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[3])} for del with matched pk`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = null
    it(`should get ${JSON.stringify(vans[4])} for row after del`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = [{ n: 0, nDeleted: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[5])} for del with unmatched pk`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = [{ n: 0, nDeleted: 0, ok: 0 }]
    it(`should get ${JSON.stringify(vans[6])} for del without valid pk`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = true
    it(`should get ${JSON.stringify(vans[7])} for err of del without valid pk`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = 'err,n,nDeleted,ok'
    it(`should get ${JSON.stringify(vans[8])} for keys of failed item`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = [
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 0, nDeleted: 0, ok: 0 },
        { n: 1, nDeleted: 1, ok: 1 },
    ]
    it(`should get ${JSON.stringify(vans[9])} for del with one failed item not breaking others`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = [null, null]
    it(`should get ${JSON.stringify(vans[10])} for rows after del with one failed item`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = [
        { n: 1, nDeleted: 1, ok: 1 },
        { n: 0, nDeleted: 0, ok: 1 },
    ]
    it(`should get ${JSON.stringify(vans[11])} for del with duplicated pk in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = ['d']
    it(`should get ${JSON.stringify(vans[12])} for all ids after del`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = [1, 0]
    it(`should get ${JSON.stringify(vans[13])} for ok of unmatched pk and invalid pk`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = [0]
    it(`should get ${JSON.stringify(vans[14])} for del which is not affected by autoGenPk`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = ['g1']
    it(`should get ${JSON.stringify(vans[15])} for rows not deleted by del without valid pk`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

})
