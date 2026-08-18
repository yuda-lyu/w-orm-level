import assert from 'assert'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('autoGenPk', function() {
    let rt = null
    let vans = {}
    let vget = {}

    before(async function() {

        w.fsDeleteFolder('./_db_autogenpk')

        let url = './_db_autogenpk'

        //autoGenPk預設為true
        let woT = WOrm({ url, db: 'worm', cl: 'def' })

        //insert未帶主鍵者由套件補值
        vget[1] = await woT.insert([{ name: 'a' }, { name: 'b' }])
        let rs = await woT.select()
        vget[2] = _.size(_.filter(rs, function(v) {
            return w.isestr(v.id)
        }))

        //自動產生之主鍵值須具足夠唯一性
        vget[3] = _.size(_.uniq(_.map(rs, 'id')))

        //save未帶主鍵者由套件補值後插入
        vget[4] = await woT.save({ name: 'c' })

        //insertBulk未帶主鍵者由套件補值
        vget[5] = await woT.insertBulk([{ name: 'd' }, { name: 'e' }])
        vget[6] = _.size(_.uniq(_.map(await woT.select(), 'id')))

        //autoGenPk為false
        let woF = WOrm({ url, db: 'worm', cl: 'nogen', autoGenPk: false })

        //帶有效主鍵者正常寫入
        vget[7] = await woF.insert([{ id: 'f1' }, { id: 'f2' }])

        //insert未帶有效主鍵者以reject拋出整批性錯誤, 且同批之有效筆數亦不得被寫入
        rt = null
        await woF.insert([{ id: 'f3' }, { name: 'no-id' }])
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[8] = rt
        vget[9] = await woF.selectByPk('f3')

        //insertBulk未帶有效主鍵者亦以reject拋出
        rt = null
        await woF.insertBulk([{ id: 'f4' }, { name: 'no-id' }])
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[10] = rt
        vget[11] = await woF.selectByPk('f4')

        //save未帶有效主鍵者亦以reject拋出, 不得降為逐筆ok為0
        rt = null
        await woF.save([{ id: 'f1', v: 1 }, { name: 'no-id' }])
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[12] = rt
        vget[13] = await woF.selectByPk('f1')

        //del不受autoGenPk影響, 未帶有效主鍵者為該筆ok為0而非整批reject
        rt = null
        await woF.del([{ id: 'f2' }, { name: 'no-id' }])
            .then(function(msg) {
                rt = _.map(msg, 'ok')
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[14] = rt

        //autoGenPk不得於各寫入函數之option逐次覆寫
        rt = null
        await woF.insert([{ name: 'no-id' }], { autoGenPk: true })
            .then(function(msg) {
                rt = 'resolve: ' + JSON.stringify(msg)
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[15] = rt
        rt = null
        await woT.insert([{ name: 'g' }], { autoGenPk: false })
            .then(function(msg) {
                rt = msg
            })
            .catch(function() {
                rt = 'reject'
            })
        vget[16] = rt

        //全表筆數確認, 僅f1留存(f2已被del刪除, 其餘批次皆整批reject而未寫入)
        vget[17] = _.map(await woF.select(), 'id')

        //close
        await woT.close()
        await woF.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_autogenpk')
    })

    vans[1] = { n: 2, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[1])} for insert without pk when autoGenPk=true`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = 2
    it(`should get ${JSON.stringify(vans[2])} for count of rows with generated pk`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = 2
    it(`should get ${JSON.stringify(vans[3])} for count of unique generated pk`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = [{ n: 1, nInserted: 1, nModified: 0, ok: 1 }]
    it(`should get ${JSON.stringify(vans[4])} for save without pk when autoGenPk=true`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = { n: 2, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[5])} for insertBulk without pk when autoGenPk=true`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 5
    it(`should get ${JSON.stringify(vans[6])} for count of unique pk in table`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = { n: 2, nInserted: 2, ok: 1 }
    it(`should get ${JSON.stringify(vans[7])} for insert with pk when autoGenPk=false`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = 'reject'
    it(`should get ${JSON.stringify(vans[8])} for insert without pk when autoGenPk=false`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

    vans[9] = null
    it(`should get ${JSON.stringify(vans[9])} for valid row in the rejected batch of insert`, async function() {
        assert.strict.deepStrictEqual(vget[9], vans[9])
    })

    vans[10] = 'reject'
    it(`should get ${JSON.stringify(vans[10])} for insertBulk without pk when autoGenPk=false`, async function() {
        assert.strict.deepStrictEqual(vget[10], vans[10])
    })

    vans[11] = null
    it(`should get ${JSON.stringify(vans[11])} for valid row in the rejected batch of insertBulk`, async function() {
        assert.strict.deepStrictEqual(vget[11], vans[11])
    })

    vans[12] = 'reject'
    it(`should get ${JSON.stringify(vans[12])} for save without pk when autoGenPk=false`, async function() {
        assert.strict.deepStrictEqual(vget[12], vans[12])
    })

    vans[13] = { id: 'f1' }
    it(`should get ${JSON.stringify(vans[13])} for valid row in the rejected batch of save`, async function() {
        assert.strict.deepStrictEqual(vget[13], vans[13])
    })

    vans[14] = [1, 0]
    it(`should get ${JSON.stringify(vans[14])} for del which is not affected by autoGenPk`, async function() {
        assert.strict.deepStrictEqual(vget[14], vans[14])
    })

    vans[15] = 'reject'
    it(`should get ${JSON.stringify(vans[15])} for insert with option.autoGenPk=true when constructor is false`, async function() {
        assert.strict.deepStrictEqual(vget[15], vans[15])
    })

    vans[16] = { n: 1, nInserted: 1, ok: 1 }
    it(`should get ${JSON.stringify(vans[16])} for insert with option.autoGenPk=false when constructor is true`, async function() {
        assert.strict.deepStrictEqual(vget[16], vans[16])
    })

    vans[17] = ['f1']
    it(`should get ${JSON.stringify(vans[17])} for remaining ids when autoGenPk=false`, async function() {
        assert.strict.deepStrictEqual(vget[17], vans[17])
    })

})
