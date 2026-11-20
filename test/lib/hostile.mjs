//敵意值建構器(帳本R-PROBE-01; unit-write-pre-error與unit-probe-readable共用, 只定義一處):
//皆為「讀取即拋錯」之呼叫端給的值, 每次呼叫重建(狀態不跨案例共用); wsemi 1.9.69起判斷函數(isobj、iseobj、isarr、isearr、isestr、isbol)對其回false而不拋錯

//proxyRevoked, 已撤銷之Proxy(任何操作皆拋TypeError)
let proxyRevoked = () => {
    let r = Proxy.revocable({ id: 'z1' }, {})
    r.revoke()
    return r.proxy
}

//proxyTagThrows, 讀取Symbol.toStringTag即拋錯(型別標籤讀取失敗)
let proxyTagThrows = () => {
    return new Proxy({ id: 'z1' }, {
        get(t, k) {
            if (k === Symbol.toStringTag) {
                throw new Error('tag-boom')
            }
            return t[k]
        },
    })
}

//proxyOwnKeysThrows, ownKeys陷阱拋錯(列自有鍵失敗; 型別標籤可讀)
let proxyOwnKeysThrows = () => {
    return new Proxy({ id: 'z1' }, {
        ownKeys() {
            throw new Error('ownKeys-boom')
        },
    })
}

//proxyGopdThrows, getOwnPropertyDescriptor陷阱拋錯(自有鍵可列, 讀描述子失敗)
let proxyGopdThrows = () => {
    return new Proxy({ id: 'z1' }, {
        getOwnPropertyDescriptor() {
            throw new Error('gopd-boom')
        },
    })
}

//proxyProtoThrows, getPrototypeOf陷阱拋錯
let proxyProtoThrows = () => {
    return new Proxy({ id: 'z1' }, {
        getPrototypeOf() {
            throw new Error('proto-boom')
        },
    })
}

//protoChainOwnKeysThrows, 一般物件但其原型為ownKeys陷阱拋錯之Proxy(wsemi iseobj之for...in沿原型鏈走到而拋錯; 自有鍵可讀)
let protoChainOwnKeysThrows = () => {
    return Object.setPrototypeOf({ id: 'z1', a: 1 }, proxyOwnKeysThrows())
}

//symbolOnlyGopdThrows, 自有鍵只有Symbol鍵且getOwnPropertyDescriptor陷阱拋錯(for...in只處理字串鍵, 故為可讀: 修前之iseobj為假而早退, 不拋錯)
let symbolOnlyGopdThrows = () => {
    return new Proxy({}, {
        ownKeys() {
            return [Symbol.for('s')]
        },
        getOwnPropertyDescriptor() {
            throw new Error('gopd-sym-boom')
        },
    })
}

//arr1Getter, 單元素陣列且[0]之存取器拋錯(isearr只在length為1時讀v[0])
let arr1Getter = () => {
    let a = [0]
    Object.defineProperty(a, '0', {
        get() {
            throw new Error('elem-getter-boom')
        },
        enumerable: true,
    })
    return a
}

//arrLenThrows, 陣列Proxy之length讀取拋錯
let arrLenThrows = () => {
    return new Proxy([{ id: 'z1' }], {
        get(t, k) {
            if (k === 'length') {
                throw new Error('len-boom')
            }
            return t[k]
        },
    })
}

//arrRevoked, 已撤銷之陣列Proxy
let arrRevoked = () => {
    let r = Proxy.revocable([{ id: 'z1' }], {})
    r.revoke()
    return r.proxy
}


//proxyGetThrows, get陷阱對任何鍵(含Symbol.toStringTag)皆拋錯(型別標籤不可讀; 讀其任何成員即拋錯)
let proxyGetThrows = () => {
    return new Proxy({ id: 'z1' }, {
        get() {
            throw new Error('get-all-boom')
        },
    })
}

//proxyGetKeyThrows, get陷阱僅對指定鍵拋錯(型別標籤可讀, 即容器可讀而該成員之讀取拋錯)
let proxyGetKeyThrows = (key) => {
    return () => {
        return new Proxy({ id: 'z1' }, {
            get(t, k) {
                if (k === key) {
                    throw new Error('get-key-boom')
                }
                return t[k]
            },
        })
    }
}

//objGetterThrows, 一般物件, 指定鍵為拋錯之自有存取器(容器可讀而成員為拋錯之getter)
let objGetterThrows = (key) => {
    return () => {
        let o = { a: 1 }
        Object.defineProperty(o, key, {
            get() {
                throw new Error('acc-boom')
            },
            enumerable: true,
        })
        return o
    }
}


export { proxyRevoked, proxyTagThrows, proxyOwnKeysThrows, proxyGopdThrows, proxyProtoThrows, protoChainOwnKeysThrows, symbolOnlyGopdThrows, arr1Getter, arrLenThrows, arrRevoked, proxyGetThrows, proxyGetKeyThrows, objGetterThrows }
