import WOrm from './src/WOrmLevel.mjs'
//import WOrm from './dist/w-orm-level.umd.js'
// import w from 'wsemi'


// w.fsDeleteFolder('./_db')

let opt = {
    url: './_db',
    db: 'worm',
    cl: 'users',
}

let rs = [
    {
        id: 'id-peter',
        name: 'peter',
        value: 123,
    },
    {
        id: 'id-rosemary',
        name: 'rosemary',
        value: 123.456,
    },
    {
        id: '',
        name: 'kettle',
        value: 456,
    },
]

let rsm = [
    {
        id: 'id-peter',
        name: 'peter(modify)'
    },
    {
        id: 'id-rosemary',
        name: 'rosemary(modify)'
    },
    {
        id: '',
        name: 'kettle(modify)'
    },
]

let rsa = [
    {
        id: 'id-rosemary',
        name: 'rosemary',
        value: 654.321,
    },
]

async function test() {

    //wo
    let wo = WOrm(opt)

    //on
    wo.on('change', function(mode, data, res) {
        console.log('change', mode)
    })
    wo.on('error', function(mode, data, err) {
        console.log('error', mode, err)
    })

    //delAll
    await wo.delAll()
        .then(function(msg) {
            console.log('delAll then', msg)
        })
        .catch(function(msg) {
            console.log('delAll catch', msg)
        })

    //insert
    await wo.insert(rs)
        .then(function(msg) {
            console.log('insert then', msg)
        })
        .catch(function(msg) {
            console.log('insert catch', msg)
        })

    //insert by returnList, 回傳與輸入等長保序之逐筆結果, nInserted為1即該筆為新增
    await wo.insert([{ id: 'id-peter' }, { id: 'id-new' }], { returnList: true })
        .then(function(msg) {
            console.log('insert(returnList) then', msg)
        })
        .catch(function(msg) {
            console.log('insert(returnList) catch', msg)
        })

    //insertBulk, 全有全無, 任一筆主鍵已存在即整批reject且不寫入任何一筆
    await wo.insertBulk([{ id: 'id-bulk1' }, { id: 'id-bulk2' }])
        .then(function(msg) {
            console.log('insertBulk then', msg)
        })
        .catch(function(msg) {
            console.log('insertBulk catch', msg.toString())
        })

    //insertBulk by existed id
    await wo.insertBulk([{ id: 'id-bulk3' }, { id: 'id-peter' }])
        .then(function(msg) {
            console.log('insertBulk(existed) then', msg)
        })
        .catch(function(msg) {
            console.log('insertBulk(existed) catch', msg.toString())
        })

    //save
    await wo.save(rsm, { autoInsert: false })
        .then(function(msg) {
            console.log('save then', msg)
        })
        .catch(function(msg) {
            console.log('save catch', msg)
        })

    //selectByPk
    let sp = await wo.selectByPk('id-rosemary')
    console.log('selectByPk', sp)

    //selectByPk by non-existed id
    let spn = await wo.selectByPk('id-non-existed')
    console.log('selectByPk(non-existed)', spn)

    //del by id-new, id-bulk1, id-bulk2
    await wo.del([{ id: 'id-new' }, { id: 'id-bulk1' }, { id: 'id-bulk2' }])
        .then(function(msg) {
            console.log('del(clean) then', msg)
        })
        .catch(function(msg) {
            console.log('del(clean) catch', msg)
        })

    //select all
    let ss = await wo.select()
    console.log('select all', ss)

    //select
    let so = await wo.select({ id: 'id-rosemary' })
    console.log('select', so)

    //select by $and, $gt, $lt
    let spa = await wo.select({ '$and': [{ value: { '$gt': 123 } }, { value: { '$lt': 200 } }] })
    console.log('select by $and, $gt, $lt', spa)

    //select by $or, $gte, $lte
    let spb = await wo.select({ '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 200 } }] })
    console.log('select by $or, $gte, $lte', spb)

    //select by $or, $and, $ne, $in, $nin
    let spc = await wo.select({ '$or': [{ '$and': [{ value: { '$ne': 123 } }, { value: { '$in': [123, 321, 123.456, 456] } }, { value: { '$nin': [456, 654] } }] }, { '$or': [{ value: { '$lte': -1 } }, { value: { '$gte': 400 } }] }] })
    console.log('select by $or, $and, $ne, $in, $nin', spc)

    // //select by regex //mingo不支援regex
    // let sr = await wo.select({ name: { $regex: 'PeT', $options: '$i' } })
    // console.log('selectReg', sr)

    //save
    await wo.save(rsa, { autoInsert: true })
        .then(function(msg) {
            console.log('save then', msg)
        })
        .catch(function(msg) {
            console.log('save catch', msg)
        })

    //del
    let d = ss.filter(function(v) {
        return v.name === 'kettle'
    })
    await wo.del(d)
        .then(function(msg) {
            console.log('del then', msg)
        })
        .catch(function(msg) {
            console.log('del catch', msg)
        })

    //del by invalid id, 未帶有效主鍵者為該筆ok為0並附err, 整批仍resolve
    await wo.del([{ name: 'no-id' }])
        .then(function(msg) {
            console.log('del(invalid id) then', msg)
        })
        .catch(function(msg) {
            console.log('del(invalid id) catch', msg)
        })

    //delAll by find
    await wo.delAll({ value: { '$gte': 600 } })
        .then(function(msg) {
            console.log('delAll(find) then', msg)
        })
        .catch(function(msg) {
            console.log('delAll(find) catch', msg)
        })

    //close, level對資料庫目錄為獨佔鎖, 用畢須關閉方能令該目錄再被開啟
    await wo.close()

}
test()
