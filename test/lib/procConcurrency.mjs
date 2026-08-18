import WOrm from '../../src/WOrmLevel.mjs'


//供unit-concurrency.test.mjs以子行程方式使用, 對同一資料庫目錄進行操作
//註: 本檔置於test/lib之下, 令mocha之預設抓取範圍(test之第一層)不會將其誤認為測試檔

//argv
let url = process.argv[2]
let cl = process.argv[3]
let prefix = process.argv[4]
let count = parseInt(process.argv[5], 10)


async function main() {

    //wo
    let wo = WOrm({ url, db: 'worm', cl })

    //run
    let nInserted = 0
    for (let i = 0; i < count; i++) {
        let r = await wo.insert({ id: `${prefix}${i}` })
        nInserted += r.nInserted
    }

    //close
    await wo.close()

    //output
    console.log(JSON.stringify({ prefix, nInserted }))

}
main()
    .catch(function(err) {
        console.log(JSON.stringify({ prefix, err: String(err) }))
        process.exit(1)
    })
