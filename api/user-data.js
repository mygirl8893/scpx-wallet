const API = require('./api').axiosApi

import * as utilsWallet from '../utils'

export function updateDataJsonApi(owner, dataJSON, e_email, hideToast = false) {
    const req = { owner, dataJSONRaw: dataJSON, e_email }
    
    if (dataJSON === undefined || dataJSON === null || dataJSON.length == 0) {
        console.error(`### updateDataJsonApi - invalid dataJSON passed - ignoring!`)
        return
    }

    console.log(`POST updateDataJsonApi - owner=${owner}`)

    return API.post(`data`, req)
    .then(res => {
        console.log(`updateDataJsonApi - ok`)
        if (res && res.data && !hideToast) {
            utilsWallet.getAppWorker().postMessage({ msg: 'NOTIFY_USER', data:  { type: 'success', headline: 'Saved Settings', info: 'Updated Scoop chain', txid: res.data.txid }})
        }
        return res.data
    })
    .catch(e => {
        const msg = e.response && e.response.data ? e.response.data.msg : e.toString()
        utilsWallet.logErr(msg)
        utilsWallet.getAppWorker().postMessage({ msg: 'NOTIFY_USER', data:  { type: 'error', headline: 'Server Error', info: msg }})
    })
}
