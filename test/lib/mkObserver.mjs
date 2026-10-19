//呼叫觀測器(unit-find-whitelist與unit-date-write共用, 只定義一處)

//tick, 讓出一個macrotask, 令延遲發出之事件有機會發出
let tick = () => new Promise((resolve) => setTimeout(resolve, 0))

//mkObserver, 建立呼叫觀測器: 事件記錄於evs, 每筆error事件附帶發出當下呼叫端之await是否已恢復(settledAtEmit, 即呼叫端可觀察之先後)
let mkObserver = (wo) => {
    let evs = []
    let cur = { settled: false }
    wo.on('error', function(mode, data, err) {
        evs.push({ t: 'error', mode, data, err, settledAtEmit: cur.settled })
    })
    wo.on('change', function(mode) {
        evs.push({ t: 'change', mode })
    })

    //run, 執行call()(回傳Promise之函數)並回傳{ ok, val, err, nAtSettle, probe, evs }, nAtSettle為結果定案當下之事件數,
    //probe為結果定案當下(同一microtask鏈內, 尚未讓出macrotask)呼叫probeFn()之回傳, evs為再讓出一個macrotask後之事件
    let run = async(call, probeFn = null) => {
        evs.length = 0
        cur = { settled: false }
        let out = { ok: false, val: null, err: null, nAtSettle: 0, probe: null, evs: [] }
        try {
            out.val = await call()
            out.ok = true
        }
        catch (err) {
            out.err = err
        }
        cur.settled = true
        out.nAtSettle = evs.length
        out.probe = probeFn ? probeFn() : null
        await tick()
        out.evs = evs.slice()
        return out
    }

    //invoke, 呼叫wo[fn](arg)
    let invoke = (fn, arg, probeFn = null) => {
        return run(() => wo[fn](arg), probeFn)
    }

    //clear
    let clear = () => {
        evs.length = 0
    }

    return { run, invoke, clear }
}


export { tick, mkObserver }
