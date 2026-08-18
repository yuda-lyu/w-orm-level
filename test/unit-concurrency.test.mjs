import assert from 'assert'
import { spawn } from 'child_process'
import _ from 'lodash-es'
import w from 'wsemi'
import WOrm from '../src/WOrmLevel.mjs'


describe('concurrency', function() {
    let vans = {}
    let vget = {}

    before(async function() {

        //runProc, 以子行程執行寫入, 回傳其stdout之JSON
        let runProc = function(args) {
            return new Promise(function(resolve) {
                let p = spawn(process.execPath, ['./test/lib/procConcurrency.mjs', ...args], { cwd: process.cwd() })
                let out = ''
                p.stdout.on('data', function(d) {
                    out += d
                })
                p.stderr.on('data', function(d) {
                    out += d
                })
                p.on('close', function() {
                    let r = null
                    try {
                        r = JSON.parse(_.trim(out))
                    }
                    catch (err) {
                        r = { err: _.trim(out) }
                    }
                    resolve(r)
                })
            })
        }

        w.fsDeleteFolder('./_db_concurrency')

        //單一行程內併發: 30個並行insert不同主鍵, nInserted總和與資料表筆數皆須為30
        let woA = WOrm({ url: './_db_concurrency', db: 'worm', cl: 'a' })
        let rsA = await Promise.all(_.map(_.range(30), function(i) {
            return woA.insert({ id: `k${i}` })
        }))
        vget[1] = [_.sumBy(rsA, 'nInserted'), _.size(await woA.select())]
        await woA.close()

        //單一行程內併發: 30個並行insert於同一主鍵, 僅一次得以插入
        let woB = WOrm({ url: './_db_concurrency', db: 'worm', cl: 'b' })
        let rsB = await Promise.all(_.map(_.range(30), function() {
            return woB.insert({ id: 'same' })
        }))
        vget[2] = [_.sumBy(rsB, 'nInserted'), _.size(await woB.select())]
        await woB.close()

        //單一行程內併發: 20個並行save於同一列各寫入不同欄位, 全部欄位須保留(不遺失更新)
        let woC = WOrm({ url: './_db_concurrency', db: 'worm', cl: 'c' })
        await woC.insert({ id: 's' })
        let rsC = await Promise.all(_.map(_.range(20), function(i) {
            return woC.save({ id: 's', [`f${i}`]: i })
        }))
        let vC = await woC.selectByPk('s')
        vget[3] = [
            _.size(_.filter(_.flatten(rsC), { ok: 1 })),
            _.size(_.filter(_.keys(vC), function(k) {
                return _.startsWith(k, 'f')
            })),
        ]
        await woC.close()

        //單一行程內併發: 不同資料表之多個實例各自持有其目錄, 併發寫入互不干擾
        let wos = _.map(_.range(5), function(j) {
            return WOrm({ url: './_db_concurrency', db: 'worm', cl: `d${j}` })
        })
        let rsD = await Promise.all(_.flatten(_.map(wos, function(wo, j) {
            return _.map(_.range(10), function(i) {
                return wo.insert({ id: `m${j}-${i}` })
            })
        })))
        let nsD = await Promise.all(_.map(wos, async function(wo) {
            return _.size(await wo.select())
        }))
        vget[4] = [_.sumBy(rsD, 'nInserted'), _.sum(nsD)]
        await Promise.all(_.map(wos, function(wo) {
            return wo.close()
        }))

        //跨行程: LevelDB對資料庫目錄為OS層之獨佔鎖, 故本行程持有時他行程一律開啟失敗而無從併發,
        //即跨行程之併發不是[保證失效]而是[無從發生], 此為README之併發宣告依據
        let woH = WOrm({ url: './_db_concurrency', db: 'worm', cl: 'x' })
        await woH.insert({ id: 'hold' })
        let rx = await runProc(['./_db_concurrency', 'x', 'P-', '5'])
        vget[5] = w.isestr(_.get(rx, 'err'))
        vget[6] = _.size(await woH.select())

        //本行程close釋放獨佔鎖後, 他行程即可正常寫入
        await woH.close()
        let ry = await runProc(['./_db_concurrency', 'x', 'P-', '5'])
        vget[7] = _.get(ry, 'nInserted', null)

        let woV = WOrm({ url: './_db_concurrency', db: 'worm', cl: 'x' })
        vget[8] = _.size(await woV.select())
        await woV.close()

    })

    after(async function() {
        w.fsDeleteFolder('./_db_concurrency')
    })

    vans[1] = [30, 30]
    it(`should get ${JSON.stringify(vans[1])} for 30 concurrent inserts with different pk in one process`, async function() {
        assert.strict.deepStrictEqual(vget[1], vans[1])
    })

    vans[2] = [1, 1]
    it(`should get ${JSON.stringify(vans[2])} for 30 concurrent inserts with same pk in one process`, async function() {
        assert.strict.deepStrictEqual(vget[2], vans[2])
    })

    vans[3] = [20, 20]
    it(`should get ${JSON.stringify(vans[3])} for 20 concurrent saves on same row in one process`, async function() {
        assert.strict.deepStrictEqual(vget[3], vans[3])
    })

    vans[4] = [50, 50]
    it(`should get ${JSON.stringify(vans[4])} for concurrent inserts by multiple instances on different storages`, async function() {
        assert.strict.deepStrictEqual(vget[4], vans[4])
    })

    vans[5] = true
    it(`should get ${JSON.stringify(vans[5])} for another process failing to open the locked storage`, async function() {
        assert.strict.deepStrictEqual(vget[5], vans[5])
    })

    vans[6] = 1
    it(`should get ${JSON.stringify(vans[6])} for rows not written by the failed process`, async function() {
        assert.strict.deepStrictEqual(vget[6], vans[6])
    })

    vans[7] = 5
    it(`should get ${JSON.stringify(vans[7])} for another process writing after close`, async function() {
        assert.strict.deepStrictEqual(vget[7], vans[7])
    })

    vans[8] = 6
    it(`should get ${JSON.stringify(vans[8])} for all rows after cross process writing`, async function() {
        assert.strict.deepStrictEqual(vget[8], vans[8])
    })

})
