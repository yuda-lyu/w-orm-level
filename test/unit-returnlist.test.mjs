import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('returnList', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_returnlist')

        let wo = WOrm({ url: './_db_returnlist', db: 'worm', cl: 'users' })

        //既有數據
        await wo.insert([{ id: 'a' }, { id: 'b' }])

        //returnList未給時為聚合物件, 形狀由呼叫點靜態決定
        vget[1] = await wo.insert([{ id: 'a' }, { id: 'c' }])

        //returnList為false時同上
        vget[2] = await wo.insert([{ id: 'a' }, { id: 'd' }], { returnList: false })

        //returnList為true時回傳與輸入等長保序之逐筆陣列, 且對位正確
        let dt = [{ id: 'a' }, { id: 'e' }, { id: 'b' }, { id: 'f' }]
        vget[3] = await wo.insert(dt, { returnList: true })
        vget[4] = _.size(vget[3]) === _.size(dt)

        //逐筆元素之鍵集合恰為{n, nInserted, ok}
        vget[5] = _.uniq(_.map(vget[3], function(v) {
            return _.keys(v).sort().join(',')
        }))

        //逐筆之n恆為1, ok恆為1
        vget[6] = _.uniq(_.map(vget[3], 'n'))
        vget[7] = _.uniq(_.map(vget[3], 'ok'))

        //同批含重複主鍵時僅首筆之nInserted為1
        vget[8] = _.map(await wo.insert([{ id: 'g' }, { id: 'g' }, { id: 'g' }], { returnList: true }), 'nInserted')

        //filter計數等於聚合模式之nInserted
        await wo.delAll()
        await wo.insert([{ id: 'x1' }, { id: 'x2' }])
        let dtc = [{ id: 'x1' }, { id: 'x3' }, { id: 'x2' }, { id: 'x4' }, { id: 'x3' }]
        let rl = await wo.insert(dtc, { returnList: true })
        await wo.delAll()
        await wo.insert([{ id: 'x1' }, { id: 'x2' }])
        let ra = await wo.insert(dtc)
        vget[9] = [
            _.size(_.filter(rl, function(v) {
                return v.nInserted === 1
            })),
            ra.nInserted,
        ]

        //輸入無效時回傳空陣列
        vget[10] = await wo.insert(null, { returnList: true })
        vget[11] = await wo.insert([], { returnList: true })

        //change事件之res即本次實際回傳值
        let evs = []
        wo.on('change', function(mode, data, res) {
            evs.push({ mode, res })
        })
        let rr = await wo.insert([{ id: 'y1' }, { id: 'y2' }], { returnList: true })
        vget[12] = _.isEqual(_.get(evs, '0.res'), rr)

        //autoGenPk為false且未帶主鍵時仍為整批reject, 不因本選項降為逐筆
        let wof = WOrm({ url: './_db_returnlist', db: 'worm', cl: 'nopk', autoGenPk: false })
        rt = null
        await wof.insert([{ id: 'z1' }, { name: 'no-id' }], { returnList: true })
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[13] = rt
        await wof.close()

        //close
        await wo.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_returnlist')
    })

    vans[1] = { n: 2, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for insert without returnList`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = { n: 2, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[2])} for insert with returnList=false`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = [
        { n: 1, nInserted: 0, ok: 1 },
        { n: 1, nInserted: 1, ok: 1 },
        { n: 1, nInserted: 0, ok: 1 },
        { n: 1, nInserted: 1, ok: 1 },
    ]
    it(`should get ${JSON.stringify(vans[3])} for insert with returnList=true`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = true
    it(`should get ${JSON.stringify(vans[4])} for length of returnList equal to input`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = ['n,nInserted,ok']
    it(`should get ${JSON.stringify(vans[5])} for keys of each item`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = [1]
    it(`should get ${JSON.stringify(vans[6])} for n of each item`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = [1]
    it(`should get ${JSON.stringify(vans[7])} for ok of each item`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = [1, 0, 0]
    it(`should get ${JSON.stringify(vans[8])} for nInserted of duplicated pk in same batch`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = [2, 2]
    it(`should get ${JSON.stringify(vans[9])} for filtered count and aggregated nInserted`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = []
    it(`should get ${JSON.stringify(vans[10])} for insert(null) with returnList=true`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = []
    it(`should get ${JSON.stringify(vans[11])} for insert([]) with returnList=true`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = true
    it(`should get ${JSON.stringify(vans[12])} for res of change event equal to returned value`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = 'reject'
    it(`should get ${JSON.stringify(vans[13])} for insert with returnList=true and autoGenPk=false without pk`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

})
