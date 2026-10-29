import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import getDiagSecrets from 'wsemi/src/getDiagSecrets.mjs'
import getStoragePaths from '../src/getStoragePaths.mjs'


//診斷輸出(帳本R-DIAG-01, 規格〈診斷輸出與遮罩〉)之單元測試
//遮罩、摘要與出口之實作與形態測試在wsemi(getDiag系列與共用語料_diagCases), 本套件刪除自寫之src/getDiag.mjs(D1單一實作), 此處只測本套件自身之宣告與原始碼規則:
//1. getStoragePaths: 傳給getDiagSecrets之paths宣告; 2. 單一出口掃描: src不得自行輸出, 不得另寫getDiag; 3. 站點盤點: reject、throw、逐筆err與診斷出口之站點全集鎖定


let dirTest = path.dirname(fileURLToPath(import.meta.url))
let dirSrc = path.join(dirTest, '..', 'src')

//fwd, 正斜線形式
let fwd = (s) => s.replace(/\\/g, '/')


describe('diaglog: getStoragePaths(paths宣告)', function() {

    it('儲存位址與url各取原樣與以工作目錄解析之絕對路徑(正斜線), 去重, 長者在前不屬本函數之責', function() {
        let cwd = fwd(process.cwd())
        assert.deepStrictEqual(getStoragePaths('./_db', 'worm', 'users'), [
            './_db/worm/users',
            `${cwd}/_db/worm/users`,
            './_db',
            `${cwd}/_db`,
        ])
        assert.deepStrictEqual(getStoragePaths('../x/./y', 'a', 'b'), [
            '../x/./y/a/b',
            `${fwd(path.resolve(cwd, '../x/y/a/b'))}`,
            '../x/./y',
            `${fwd(path.resolve(cwd, '../x/y'))}`,
        ])
    })

    it('絕對路徑之url(磁碟機代號、根、反斜線)不另推導絕對形式', function() {
        assert.deepStrictEqual(getStoragePaths('/abs/dir', 'w', 'c'), ['/abs/dir/w/c', '/abs/dir'])
        assert.deepStrictEqual(getStoragePaths('D:/abs/dir', 'w', 'c'), ['D:/abs/dir/w/c', 'D:/abs/dir'])
        assert.deepStrictEqual(getStoragePaths('D:\\abs\\dir', 'w', 'c'), ['D:\\abs\\dir/w/c', 'D:\\abs\\dir'])
    })

    it('過短或全為路徑符號之url(.、./、..)不推導絕對形式(其絕對形式即工作目錄, 列入會吞掉大量無關文字), 儲存位址本身仍列', function() {
        let cwd = fwd(process.cwd())
        for (let u of ['.', './', '..', '.\\']) {
            let r = getStoragePaths(u, 'worm', 'users')
            assert.ok(r.includes(`${u}/worm/users`), u)
            assert.ok(!r.includes(cwd), `${u}: 不得列入工作目錄本身`)
            assert.ok(!r.includes(fwd(path.resolve(cwd, '..'))), `${u}: 不得列入上層目錄本身`)
        }
    })

    it('與getDiagSecrets整合: detail清單含原樣、反斜線形式與絕對路徑形式; reject清單不含(Q3: 對外錯誤值不遮儲存路徑); 全為路徑符號者不收', function() {
        let ss = getDiagSecrets({ paths: getStoragePaths('./_db', 'worm', 'users') })
        let cwd = fwd(process.cwd())
        for (let p of ['./_db/worm/users', '.\\_db\\worm\\users', `${cwd}/_db/worm/users`, `${cwd}/_db/worm/users`.replace(/\//g, '\\'), './_db', `${cwd}/_db`]) {
            assert.ok(ss.detail.includes(p), `detail缺${p}`)
        }
        assert.deepStrictEqual(ss.reject, [], 'reject清單只含憑證, 本套件無憑證')
        let ss2 = getDiagSecrets({ paths: getStoragePaths('.', 'worm', 'users') })
        assert.ok(ss2.detail.includes('./worm/users'))
        assert.ok(!ss2.detail.includes('.') && !ss2.detail.includes(cwd))
    })

    it('db與cl單獨不列入(worm、test之類常用字會吞掉大量無關文字)', function() {
        let r = getStoragePaths('./_db', 'worm', 'users')
        assert.ok(!r.includes('worm') && !r.includes('users'))
    })

})


describe('diaglog: 單一出口掃描(規則①, D1單一實作)', function() {

    //strip, 移除區塊註解與行註解(//前須為行首或空白, 以免誤砍字串內之網址)
    let strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((ln) => ln.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')

    let files = fs.readdirSync(dirSrc).filter((fn) => fn.endsWith('.mjs') || fn.endsWith('.js'))

    //輸出類(任何檔皆不得出現)與環境類(僅getStoragePaths.mjs取工作目錄得出現)
    let reOut = [/\bconsole\b/, /\bstdout\b/, /\bstderr\b/, /\bemitWarning\b/, /\brequire\b/, /\bimport\s*\(/]
    let reEnv = [/\bprocess\b/, /\bglobalThis\b/, /\bglobal\b/]

    it('src只有WOrmLevel.mjs與getStoragePaths.mjs: 無自寫之getDiag.mjs(遮罩、摘要與出口一律用wsemi之共用實作)', function() {
        assert.deepStrictEqual(files.sort(), ['WOrmLevel.mjs', 'getStoragePaths.mjs'])
    })

    it('WOrmLevel.mjs之診斷出口來自wsemi/src/getDiag.mjs與getDiagSecrets.mjs, 不另寫等價實作', function() {
        let code = strip(fs.readFileSync(path.join(dirSrc, 'WOrmLevel.mjs'), 'utf8'))
        assert.ok(/import getDiag from 'wsemi\/src\/getDiag\.mjs'/.test(code))
        assert.ok(/import getDiagSecrets from 'wsemi\/src\/getDiagSecrets\.mjs'/.test(code))
        assert.ok(!/\bfunction\s+(maskText|cpMask|getBriefErr|getSecrets|maskErr|cpDetail|swallow)\b/.test(code))
    })

    it('src不得出現console、stdout、stderr、emitWarning、require、動態import之實際用法(註解不計; 含console?.log、別名與括號存取); process、globalThis、global僅getStoragePaths.mjs得出現且只用於取工作目錄', function() {
        let bad = []
        for (let fn of files) {
            let code = strip(fs.readFileSync(path.join(dirSrc, fn), 'utf8'))
            for (let re of reOut) {
                if (re.test(code)) {
                    bad.push(`${fn}: ${re}`)
                }
            }
            if (fn !== 'getStoragePaths.mjs') {
                for (let re of reEnv) {
                    if (re.test(code)) {
                        bad.push(`${fn}: ${re}`)
                    }
                }
            }
        }
        assert.deepStrictEqual(bad, [])
        let code = strip(fs.readFileSync(path.join(dirSrc, 'getStoragePaths.mjs'), 'utf8'))
        let uses = code.match(/\b(process|globalThis|global)\b[^\n]*/g) || []
        assert.deepStrictEqual(uses.map((s) => s.trim()), ['globalThis.process.cwd())']) //cwd = String(globalThis.process.cwd())
    })

    it('掃描非空轉: 掃描器對各種直接輸出寫法皆命中, 註解不計', function() {
        let res = [...reOut, ...reEnv]
        for (let s of ['console.log(1)', 'console?.log(1)', 'let c = console', 'console["log"](1)', 'process.stdout.write(1)', 'process["stderr"].write(1)', 'process.emitWarning(1)', 'globalThis.console.log(1)', 'global.console.log(1)', 'require(\'util\')', 'import(\'util\')']) {
            assert.ok(res.some((re) => re.test(strip(s))), s)
        }
        assert.ok(!res.some((re) => re.test(strip('// console.log(1)\n/* process.stdout */ let a = 1'))))
    })

})


describe('diaglog: 站點盤點(R-DIAG-01站點全集, 原始碼鎖定; 行為由api-diagwire驗證)', function() {

    let code = strip2(fs.readFileSync(path.join(dirSrc, 'WOrmLevel.mjs'), 'utf8'))

    //strip2, 同上(移除註解)
    function strip2(s) {
        return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((ln) => ln.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
    }

    //count, 子字串/樣式出現次數
    let count = (re) => (code.match(re) || []).length

    it('7個操作之catch站點一律res = outErr(err)(外來值經diag.err), 不得有res = err之原樣交出', function() {
        assert.strictEqual(count(/\bres = outErr\(err\)/g), 7)
        assert.strictEqual(count(/\bres = err\b/g), 0)
        assert.strictEqual(count(/isErr = true\n\s+res = /g), 8) //7個catch站點 + selectCore之can not select檢查(套件自身之固定詞彙, 不經outErr)
        assert.strictEqual(count(/\bcatch \(err\) \{\n\s+isErr = true\n\s+res = outErr\(err\)/g), 7)
    })

    it('逐筆結果之err欄位(save、del)皆經outMsg(建立時即遮), 不得有err: getErrMsg(...)', function() {
        assert.strictEqual(count(/\berr: outMsg\(err\)/g), 2)
        assert.strictEqual(count(/\berr: getErrMsg\(/g), 0)
        assert.strictEqual(count(/\berr: /g), 3) //另一處為del之固定詞彙invalid id(msgPk), 不遮
        assert.ok(/err: `invalid id: \$\{msgPk\} at \[data\[\$\{k\}\]\.id\]`/.test(code))
    })

    it('Promise.reject之引數全集: procClosed之固定詞彙1、procFind之pf.err 2(固定詞彙, 不包)、7個操作之outErr後之res', function() {
        let args = code.split('\n').filter((ln) => /Promise\.reject\(/.test(ln)).map((ln) => ln.replace(/^.*Promise\.reject\(/, '').replace(/\)\s*$/, ''))
        let m = {}
        for (let a of args) {
            m[a] = (m[a] || 0) + 1
        }
        assert.deepStrictEqual(m, { 'new Error(msg)': 1, 'pf.err': 2, 'res': 7 })
    })

    it('throw之全集: 固定詞彙mkOwnErr(7)、建構期良構檢核之固定訊息(1)、isoFind之固定訊息(1)、外來值經diag.err(2: Level建構與close)', function() {
        let ts = (code.match(/\bthrow\s+(?:new Error\(|mkOwnErr\(|diag\.err\()/g) || []).map((s) => s.replace(/\s+/g, ' '))
        let m = {}
        for (let t of ts) {
            m[t] = (m[t] || 0) + 1
        }
        assert.deepStrictEqual(m, {
            'throw mkOwnErr(': 7,
            'throw new Error(': 2, //chkOptStr(良構檢核, 訊息為固定詞彙invalid opt.<名>: <原因>)與isoFind(invalid find: Date year...)
            'throw diag.err(': 2,
        })
        assert.strictEqual(count(/\bthrow\b/g), 11) //無其他throw(如throw err原樣重拋)

        //new Error之全集(5): mkOwnErr內1、chkOptStr 1、isoFind 1、procClosed 1、selectCore之can not select 1, 皆為固定詞彙(不經遮罩)
        assert.strictEqual(count(/\bnew Error\(/g), 5)
        assert.strictEqual(count(/\bnew Error\(msg\)/g), 2) //mkOwnErr內與procClosed
    })

    it('診斷出口diag(...)之站點全集: 僅change handler threw、error handler threw兩站, 摘要為{ mode, ...diag.brief(err) }, 細節為拋出值, 第4參數level省略(皆為stdout之console.log)', function() {
        let calls = code.match(/\bdiag\([^\n]*/g) || []
        assert.deepStrictEqual(calls.map((s) => s.trim()), [
            'diag(\'change handler threw\', { mode, ...diag.brief(err) }, () => err)',
            'diag(\'error handler threw\', { mode, ...diag.brief(errEmit) }, () => errEmit)',
        ])
    })

    it('getDiag之宣告: secrets取自getDiagSecrets({ paths })、codes為[\'level\']、safeKeys為[\'mode\'](safe只用mode)', function() {
        assert.ok(/getDiag\(opt, \{\s*secrets: getDiagSecrets\(\{ paths: getStoragePaths\(url, db, cl\) \}\),\s*codes: \['level'\],\s*safeKeys: \['mode'\],\s*\}\)/.test(code))
    })

    it('外來值之diag.err站點: Level建構期(try/catch)與close()之後端reject', function() {
        assert.strictEqual(count(/\bdiag\.err\(err\)/g), 3) //outErr內1 + 建構期1 + close 1
        assert.ok(/client = new Level\(storage, \{ valueEncoding: 'json' \}\)\s*\}\s*catch \(err\) \{\s*throw diag\.err\(err\)/.test(code))
        assert.ok(/await client\.close\(\)\s*\}\s*catch \(err\) \{\s*throw diag\.err\(err\)\s*\}\s*_cache = null/.test(code))
    })

})
