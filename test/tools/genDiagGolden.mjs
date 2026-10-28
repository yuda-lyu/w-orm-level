//產生診斷輸出測試之固定預期值(diagGolden.json): 以修改前之程式(git HEAD之src副本)執行diagScenario, 供回傳契約之比對
//用法: node test/tools/genDiagGolden.mjs <修改前之WOrmLevel.mjs路徑> <輸出json路徑>
//  例: git archive HEAD src | tar -x -C ./tmp/level-run01/pre, 再 node test/tools/genDiagGolden.mjs ./tmp/level-run01/pre/src/WOrmLevel.mjs ./test/tools/diagGolden.json
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { scenario } from './diagScenario.mjs'
import { CONFIGS } from './diagConfigs.mjs'


let main = async () => {
    let src = path.resolve(process.argv[2])
    let out = path.resolve(process.argv[3])
    console.log('src', src)
    console.log('out', out)
    let mod = await import(pathToFileURL(src).href)
    let WOrm = mod.default

    //修改前之程式於訂閱函數拋錯時會console.log, 產生預期值時吞下
    let logOrg = console.log
    let golden = {}
    let n = 0
    try {
        console.log = () => {}
        for (let cfg of Object.keys(CONFIGS)) {
            for (let bad of [false, true]) {
                let url = `./test/_tmp/diaggolden_${n++}`
                fs.rmSync(url, { recursive: true, force: true })
                golden[`${cfg}|${bad ? 'bad' : 'ok'}`] = await scenario(WOrm, { url, db: 'worm', cl: 'users', ...CONFIGS[cfg] }, bad)
                fs.rmSync(url, { recursive: true, force: true })
            }
        }
    }
    finally {
        console.log = logOrg
    }
    fs.writeFileSync(out, JSON.stringify(golden, null, 2))
    console.log('keys', Object.keys(golden))
}
main().catch((err) => {
    console.log(err)
    process.exit(1)
})
