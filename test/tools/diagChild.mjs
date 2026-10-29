//診斷輸出之串流驗證用子行程(api-diagwire.test.mjs): 建立實例, change與error訂閱函數皆拋錯, 令兩個診斷站點各輸出一次後離開
//用法: node test/tools/diagChild.mjs <資料夾> [logDetail]
import WOrm from '../../src/WOrmLevel.mjs'


let main = async () => {
    let opt = { url: process.argv[2], db: 'worm', cl: 'users' }
    if (process.argv[3] === 'logDetail') {
        opt.logDetail = true
    }
    let wo = WOrm(opt)
    wo.on('change', () => {
        throw new Error('listener boom')
    })
    wo.on('error', () => {
        throw new Error('listener boom')
    })
    await wo.insert({ id: 'a1' })
    await wo.insert({ id: 'bad\uD800' }).catch(() => {})
    await wo.close()
}
main().catch((err) => {
    process.stderr.write(`child failed: ${err && err.message}\n`)
    process.exit(1)
})
