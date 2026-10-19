import assert from 'assert'


//呼叫端傳入物件之逐節點快照(unit-find-whitelist與unit-date-write共用, 只定義一處)

//timeOf, 以內部槽取Date之時間值, 非Date回傳undefined(跨realm、子類別、被改Symbol.toStringTag之Date皆可辨)
let timeOf = (v) => {
    try {
        return Date.prototype.getTime.call(v)
    }
    catch (err) {
        return undefined
    }
}

//leaves: 取物件之全部節點(物件節點記鍵序,Date節點記毫秒,皆記參照), 供reject後確認呼叫端實際傳入之同一物件逐節點未被改動; 物件須為無環
let leaves = (v, p = 'root', out = []) => {
    let ms = timeOf(v)
    if (ms !== undefined) {
        out.push({ p, ref: v, ms })
    }
    else if (v !== null && typeof v === 'object') {
        out.push({ p, ref: v, keys: Object.keys(v).join(',') })
        for (let k of Object.keys(v)) {
            leaves(v[k], `${p}.${k}`, out)
        }
    }
    else {
        out.push({ p, ref: v })
    }
    return out
}

//chkSame: 兩次leaves之結果須逐節點相同(參照、毫秒、鍵序)
let chkSame = (a, b) => {
    assert.strict.equal(a.length, b.length, 'object should keep the same number of nodes')
    for (let i = 0; i < a.length; i++) {
        assert.strict.equal(a[i].p, b[i].p)
        assert.strict.equal(a[i].ref, b[i].ref, `${a[i].p} should keep the same reference or value`)
        assert.strict.equal(a[i].ms, b[i].ms, `${a[i].p} should keep the same time value`)
        assert.strict.equal(a[i].keys, b[i].keys, `${a[i].p} should keep the same keys`)
    }
}


export { timeOf, leaves, chkSame }
