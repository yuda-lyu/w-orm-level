import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('event', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_event')

        let url = './_db_event'

        //evs, 蒐集事件, 事件名與各參數皆記錄以供比對
        let mkEvs = function(wo) {
            let evs = []
            wo.on('change', function(mode, data, res) {
                evs.push({ ev: 'change', mode, data, res })
            })
            wo.on('error', function(mode, data, err) {
                evs.push({ ev: 'error', mode, data, err })
            })
            return evs
        }

        //change事件之形狀: 逐筆函數以整批為單位發出一次
        let woC = WOrm({ url, db: 'worm', cl: 'ch' })
        let evsC = mkEvs(woC)
        await woC.insert([{ id: 'c1' }, { id: 'c2' }])
        await woC.insertBulk([{ id: 'c3' }, { id: 'c4' }])
        await woC.save({ id: 'c1', a: 1 })
        await woC.del([{ id: 'c2' }, { id: 'c3' }])
        await woC.delAll()
        vget[1] = _.map(evsC, function(v) {
            return `${v.ev}:${v.mode}`
        })
        await woC.close()

        //change之res即本次回傳結果
        let woR = WOrm({ url, db: 'worm', cl: 'res' })
        let evsR = mkEvs(woR)
        let rr = await woR.insert([{ id: 'r1' }])
        vget[2] = _.isEqual(_.get(evsR, '0.res'), rr)

        //change之data為本次輸入數據, delAll固定為null
        await woR.delAll()
        vget[3] = _.get(_.find(evsR, { mode: 'delAll' }), 'data')
        await woR.close()

        //讀取函數不發出change事件
        let woS = WOrm({ url, db: 'worm', cl: 'sel' })
        let evsS = mkEvs(woS)
        await woS.select()
        await woS.selectByPk('none')
        vget[4] = _.size(evsS)
        await woS.close()

        //save之逐筆插入另發mode為insert之事件, 且早於整批save事件
        let woI = WOrm({ url, db: 'worm', cl: 'ins' })
        let evsI = mkEvs(woI)
        await woI.save({ id: 'i1', a: 1 })
        vget[5] = _.map(evsI, function(v) {
            return `${v.ev}:${v.mode}`
        })
        await woI.close()

        //error事件: 整批性錯誤, 須於reject之前發出且err為字串
        let woE = WOrm({ url, db: 'worm', cl: 'errb', autoGenPk: false })
        let evsE = mkEvs(woE)
        rt = null
        await woE.insert({ name: 'no-id' })
            .then(function() {
                rt = 'resolve'
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[6] = rt
        vget[7] = _.map(evsE, function(v) {
            return `${v.ev}:${v.mode}`
        })
        vget[8] = w.isestr(_.get(evsE, '0.err'))
        await woE.close()

        //error事件: 逐筆失敗, 整批仍resolve且每筆一次, err與該筆之err欄位一致
        let woD = WOrm({ url, db: 'worm', cl: 'errd' })
        let evsD = mkEvs(woD)
        await woD.insert([{ id: 'd1' }])
        let rd = await woD.del([{ id: 'd1' }, { name: 'no-id' }, { name: 'no-id2' }])
        vget[9] = _.map(evsD, function(v) {
            return `${v.ev}:${v.mode}`
        })
        vget[10] = _.get(_.find(evsD, { ev: 'error' }), 'err') === _.get(rd, '1.err')
        await woD.close()

        //正常結果不得發出error事件
        let woN = WOrm({ url, db: 'worm', cl: 'norm' })
        let evsN = mkEvs(woN)
        await woN.insert([{ id: 'n1' }])
        await woN.insert([{ id: 'n1' }]) //全數已存在
        await woN.save({ id: 'n1' }) //合併後內容相同
        await woN.del([{ id: 'n-none' }]) //主鍵未命中
        await woN.delAll({ id: 'n-none' }) //條件無命中
        await woN.selectByPk('n-none') //查無數據
        await woN.select({ id: 'n-none' }) //查無數據
        vget[11] = _.size(_.filter(evsN, { ev: 'error' }))
        await woN.close()

        //操作行為不得因監聽者之有無而改變
        let mk = function(cl, withListener) {
            let wo = WOrm({ url, db: 'worm', cl })
            if (withListener) {
                wo.on('error', function() {})
                wo.on('change', function() {})
            }
            return wo
        }
        let woA = mk('lsn-a', true)
        let woB = mk('lsn-b', false)
        let run = async function(wo) {
            let ms = []
            ms.push(await wo.insert([{ id: 'p1' }]))
            ms.push(await wo.del([{ id: 'p1' }, { name: 'no-id' }]))
            ms.push(await wo.save([{ id: 'p2', a: 1 }]))
            let r = null
            await wo.selectByPk('none')
                .then(function(msg) {
                    r = msg
                })
                .catch(function(msg) {
                    r = 'reject: ' + msg.toString()
                })
            ms.push(r)
            return ms
        }
        let msA = await run(woA)
        let msB = await run(woB)
        vget[12] = _.isEqual(msA, msB)
        await woA.close()
        await woB.close()

        //訂閱函數拋錯不得影響本次操作
        let woX = WOrm({ url, db: 'worm', cl: 'throw' })
        woX.on('change', function() {
            throw new Error('error in change listener')
        })
        woX.on('error', function() {
            throw new Error('error in error listener')
        })
        rt = null
        await woX.insert([{ id: 'x1' }])
            .then(function(msg) {
                rt = msg
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[13] = rt
        rt = null
        await woX.del([{ name: 'no-id' }])
            .then(function(msg) {
                rt = _.map(msg, 'ok')
            })
            .catch(function(msg) {
                rt = 'reject: ' + msg.toString()
            })
        vget[14] = rt
        vget[15] = await woX.selectByPk('x1')
        await woX.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_event')
    })

    vans[1] = [
        'change:insert',
        'change:insertBulk',
        'change:save',
        'change:del',
        'change:delAll',
    ]
    it(`should get ${JSON.stringify(vans[1])} for change events`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = true
    it(`should get ${JSON.stringify(vans[2])} for res of change event equal to returned value`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = null
    it(`should get ${JSON.stringify(vans[3])} for data of change event of delAll`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = 0
    it(`should get ${JSON.stringify(vans[4])} for count of events emitted by select and selectByPk`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = ['change:insert', 'change:save']
    it(`should get ${JSON.stringify(vans[5])} for events of save with auto insert`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 'reject'
    it(`should get ${JSON.stringify(vans[6])} for insert without pk when autoGenPk=false`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = ['error:insert']
    it(`should get ${JSON.stringify(vans[7])} for events of batch level error`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = true
    it(`should get ${JSON.stringify(vans[8])} for err of error event being string`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = ['change:insert', 'error:del', 'error:del', 'change:del']
    it(`should get ${JSON.stringify(vans[9])} for events of item level error`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = true
    it(`should get ${JSON.stringify(vans[10])} for err of error event equal to err of the item`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = 0
    it(`should get ${JSON.stringify(vans[11])} for count of error events emitted by normal results`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = true
    it(`should get ${JSON.stringify(vans[12])} for results with and without listeners being the same`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = { n: 1, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[13])} for insert with throwing listener`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = [0]
    it(`should get ${JSON.stringify(vans[14])} for del with throwing listener`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = { id: 'x1' }
    it(`should get ${JSON.stringify(vans[15])} for row inserted with throwing listener`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

})
