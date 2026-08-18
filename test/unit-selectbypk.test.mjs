import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('selectByPk', function() {
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_selectbypk')

        let wo = WOrm({ url: './_db_selectbypk', db: 'worm', cl: 'users' })

        await wo.insert([
            { id: 'id-peter', name: 'peter', value: 123 },
            { id: 'id-rosemary', name: 'rosemary', value: 123.456 },
        ])

        //主鍵命中, 回傳該筆數據物件
        vget[1] = await wo.selectByPk('id-peter')

        //主鍵命中者之內容須與select({主鍵})[0]相同
        let vs = await wo.select({ id: 'id-peter' })
        vget[2] = _.isEqual(vget[1], _.get(vs, 0))

        //主鍵未命中, 回傳null而非undefined或空陣列
        vget[3] = await wo.selectByPk('id-not-existed')

        //主鍵值無效(未給), 回傳null且不reject
        let rt = null
        await wo.selectByPk()
            .then(function(msg) {
                rt = msg
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[4] = rt

        //主鍵值無效(型別不符), 回傳null且不reject
        rt = null
        await wo.selectByPk(123)
            .then(function(msg) {
                rt = msg
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[5] = rt

        //命中之判定基準須與insert一致: selectByPk回傳物件者, insert須視為已存在而不插入
        let ri = await wo.insert({ id: 'id-peter', name: 'other' })
        vget[6] = ri

        //命中之判定基準須與del一致
        let rd = await wo.del({ id: 'id-rosemary' })
        vget[7] = rd
        vget[8] = await wo.selectByPk('id-rosemary')

        //讀取函數不得有副作用, 連續呼叫selectByPk後全表筆數不變
        let n1 = _.size(await wo.select())
        await wo.selectByPk('id-not-existed')
        await wo.selectByPk('id-peter')
        let n2 = _.size(await wo.select())
        vget[9] = [n1, n2]

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_selectbypk')
    })

    vans[1] = { id: 'id-peter', name: 'peter', value: 123 }
    it(`should get ${JSON.stringify(vans[1])} for selectByPk with matched pk`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = true
    it(`should get ${JSON.stringify(vans[2])} for selectByPk equal to select({pk})[0]`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = null
    it(`should get ${JSON.stringify(vans[3])} for selectByPk with unmatched pk`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = null
    it(`should get ${JSON.stringify(vans[4])} for selectByPk without pk`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = null
    it(`should get ${JSON.stringify(vans[5])} for selectByPk with invalid pk type`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = { n: 1, nInserted: 0, ok: 1 }
    it(`should get ${JSON.stringify(vans[6])} for insert with pk which selectByPk matched`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = [{ n: 1, nDeleted: 1, ok: 1 }]
    it(`should get ${JSON.stringify(vans[7])} for del with pk which selectByPk matched`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = null
    it(`should get ${JSON.stringify(vans[8])} for selectByPk after del`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = [1, 1]
    it(`should get ${JSON.stringify(vans[9])} for size of table before and after selectByPk`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

})
