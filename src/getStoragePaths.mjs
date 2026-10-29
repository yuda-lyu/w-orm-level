//儲存路徑清單, 供getDiagSecrets之paths宣告(診斷輸出遮罩用; 依規格〈診斷輸出與遮罩〉Q3, 對外錯誤值不遮儲存路徑)
//只算路徑本身: 儲存位址`${url}/${db}/${cl}`(即傳給Level者)與url, 各取原樣與以目前工作目錄解析之絕對路徑(正斜線);
//正反斜線、磁碟機代號大小寫、UNC等字串變體, 以及過短或全為路徑符號者之剔除, 皆由wsemi之getDiagSecrets處理, 此處不重做;
//唯過短或全為路徑符號之url(如'.'、'./')不另推導絕對路徑(其絕對形式即工作目錄, 列入會吞掉大量無關文字)
//不靜態import Node內建模組(dist由rollup打包為UMD, gDistRollup.mjs之external只列level、mingo): 以globalThis.process.cwd()取工作目錄, 取不到(非Node)則略過絕對路徑


function isUsable(s) {
    //可推導絕對路徑者: 至少3字元, 且不全為路徑符號與空白
    return typeof s === 'string' && s.length >= 3 && /[^./\\\s]/.test(s)
}


function resolveAbs(cwd, s) {
    //以cwd解析相對路徑s(僅處理.與..段, 正斜線輸出); s已為絕對路徑(磁碟機代號或根)者回傳null
    if (/^([A-Za-z]:)?[\\/]/.test(s)) {
        return null
    }
    let segs = cwd.replace(/\\/g, '/').split('/')
    for (let seg of s.replace(/\\/g, '/').split('/')) {
        if (seg === '' || seg === '.') {
            continue
        }
        if (seg === '..') {
            if (segs.length > 1) {
                segs.pop()
            }
            continue
        }
        segs.push(seg)
    }
    return segs.join('/')
}


function getStoragePaths(url, db, cl) {
    let cwd = ''
    try {
        cwd = String(globalThis.process.cwd())
    }
    catch (err) {
        //非Node環境無cwd, 略過絕對路徑形式
    }
    let all = []
    for (let s of [`${url}/${db}/${cl}`, url]) {
        all.push(s)
        if (cwd !== '' && isUsable(s)) {
            let abs = resolveAbs(cwd, s)
            if (abs !== null) {
                all.push(abs)
            }
        }
    }
    return all.filter((s, k) => all.indexOf(s) === k)
}


export default getStoragePaths
