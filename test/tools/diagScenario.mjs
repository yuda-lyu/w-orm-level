//診斷輸出測試(R-DIAG-01)之共用情境: 對一個WOrmLevel實例依序執行各操作(成功與失敗), 回傳各結果與事件payload, 供回傳契約之比對
//同一情境亦於修改前之程式(git HEAD)執行以產生固定預期值(golden, diagGolden.json), 故此檔不得依賴R-DIAG-01之任何新功能


//哨兵: 使用端資料值、主鍵與訂閱函數拋錯之文字, 測試藉此檢查診斷輸出是否含個資
let ID = 'u-secret-001@example.com'
let NAME = 'AliceSecretName'
let LISTENER_MSG = `listener ${ID} ${NAME}`


let RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g


//norm, 轉為可序列化比對之形(自動產生之主鍵為uuid, 換成固定字樣; Date轉ISO字串)
let norm = (v) => {
    return JSON.parse(JSON.stringify(v === undefined ? null : v).replace(RE_UUID, '<uuid>'))
}


let settle = async (pm) => {
    try {
        return { ok: norm(await pm) }
    }
    catch (err) {
        return { err: String(err && err.message ? err.message : err) }
    }
}


//scenario, withBadListener為true時change與error訂閱函數皆拋錯(觸發診斷輸出之站點); 回傳{ out, evs, dbAfter }, 皆已norm
async function scenario(WOrm, opt, withBadListener) {
    let wo = WOrm(opt)
    let evs = []
    wo.on('change', (m, d, r) => {
        evs.push(['change', m, norm(d), norm(r)])
        if (withBadListener) {
            throw new Error(LISTENER_MSG)
        }
    })
    wo.on('error', (m, d, e) => {
        evs.push(['error', m, norm(d), e])
        if (withBadListener) {
            throw new Error(LISTENER_MSG)
        }
    })
    let out = []
    out.push(await settle(wo.delAll()))
    out.push(await settle(wo.insert([{ id: ID, name: NAME, value: 1, t: new Date('2026-01-02T03:04:05.678Z') }, { id: 'a2', name: 'n2', value: 2 }])))
    out.push(await settle(wo.insert({ id: ID, name: 'dup' })))
    out.push(await settle(wo.insert({ id: 'a9', name: 'ret' }, { returnList: true })))
    out.push(await settle(wo.insert({ name: 'auto' })))
    out.push(await settle(wo.insertBulk([{ id: ID, name: 'dup' }])))
    out.push(await settle(wo.insertBulk([{ id: 'b1', name: 'b1' }, { id: 'b2', name: 'b2' }])))
    out.push(await settle(wo.save([{ id: ID, name: `${NAME}x` }, { id: 'a3', name: 'n3' }])))
    out.push(await settle(wo.save({ id: 'bad\uD800' })))
    out.push(await settle(wo.select({ id: ID })))
    out.push(await settle(wo.select()))
    out.push(await settle(wo.select({ id: ID })))
    out.push(await settle(wo.selectByPk('a2')))
    out.push(await settle(wo.selectByPk('none')))
    out.push(await settle(wo.select({ $foo: 1 })))
    out.push(await settle(wo.insert({ id: 'd1', t: new Date(8.64e15) })))
    out.push(await settle(wo.del([{ id: 'a2' }, { id: '' }, { id: 'b1' }])))
    out.push(await settle(wo.delAll({ id: 'a3' })))
    out.push(await settle(wo.delAll({ $foo: 1 })))
    out.push(await settle(wo.select()))
    out.push(await settle(wo.delAll()))
    await wo.close()
    out.push(await settle(wo.select()))
    out.push(await settle(wo.selectByPk('a2')))
    out.push(await settle(wo.insert({ id: 'z1' })))
    out.push(await settle(wo.insertBulk([{ id: 'z2' }])))
    out.push(await settle(wo.save({ id: 'z3' })))
    out.push(await settle(wo.del({ id: 'z4' })))
    out.push(await settle(wo.delAll()))
    return { out, evs }
}


export { ID, NAME, LISTENER_MSG, scenario, settle, norm }
