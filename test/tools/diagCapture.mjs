//診斷輸出測試(R-DIAG-01)之輸出擷取: 於一段非同步作業期間擷取console.*、process.stdout.write、process.stderr.write與process警告, 作業結束(含讓出一個macrotask)後還原
import { inspect } from 'util'


let tick = () => new Promise((resolve) => setTimeout(resolve, 0))


//capture, 執行fn()並回傳{ calls, result }; calls為[{ fn, args }], fn為'console.log'等或'stdout.write'、'stderr.write'、'warning'
async function capture(fn) {
    let calls = []
    let names = ['log', 'info', 'warn', 'error', 'debug']
    let orgs = {}
    for (let name of names) {
        orgs[name] = console[name]
        console[name] = (...args) => {
            calls.push({ fn: `console.${name}`, args })
        }
    }
    let orgOut = process.stdout.write
    let orgErr = process.stderr.write
    process.stdout.write = (chunk) => {
        calls.push({ fn: 'stdout.write', args: [String(chunk)] })
        return true
    }
    process.stderr.write = (chunk) => {
        calls.push({ fn: 'stderr.write', args: [String(chunk)] })
        return true
    }
    let onWarn = (w) => {
        calls.push({ fn: 'warning', args: [String(w && w.message)] })
    }
    process.on('warning', onWarn)
    try {
        let result = await fn()
        await tick()
        await tick()
        return { calls, result }
    }
    finally {
        process.removeListener('warning', onWarn)
        process.stdout.write = orgOut
        process.stderr.write = orgErr
        for (let name of names) {
            console[name] = orgs[name]
        }
    }
}


//dump, 把擷取到的引數序列化為完整文字(含隱藏屬性、error之stack與cause), 供檢查是否含哨兵字串
let dump = (v) => {
    return inspect(v, { depth: null, showHidden: true, maxStringLength: null, maxArrayLength: null, breakLength: Infinity })
}


export { tick, capture, dump }
