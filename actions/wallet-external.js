// Distributed under AGPLv3 license: see /LICENSE for terms. Copyright 2019-2020 Dominic Morris.

const bitcoinJsLib = require('bitcoinjs-lib')
const bitgoUtxoLib = require('bitgo-utxo-lib')
const bchAddr = require('bchaddrjs')
const BigNumber = require('bignumber.js')
const _ = require('lodash')

const actionsWallet = require('.')
const walletUtxo = require('./wallet-utxo')
const walletAccount = require('./wallet-account')

const configWallet = require('../config/wallet')
const configExternal = require('../config/wallet-external')

const utilsWallet = require('../utils')

Array.prototype.extend = function (other_array) {
    if (other_array) {
        other_array.forEach(function (v) { this.push(v) }, this)
    }
}

module.exports = {

    //
    // process asset full state updates
    //
    getAddressFull_ProcessResult: (res, asset, addrNdx) => {
        utilsWallet.debug(`getAddressFull_ProcessResult - ${asset.symbol} addrNdx=${addrNdx}...`)
        
        if (!res || !res.txs) return null
        if (configWallet.TEST_PAD_TXS) testPadTxs(res)
        if (configWallet.TEST_LARGE_BALANCE > 0) res.balance = configWallet.TEST_LARGE_BALANCE 

        const balanceChanged = res.balance != asset.addresses[addrNdx].balance
                            || res.unconfirmedBalance != asset.addresses[addrNdx].unconfirmedBalance

        const firstLoad = asset.addresses[addrNdx].lastAddrFetchAt === undefined

        var testingPaddedTxs = configWallet.TEST_PAD_TXS ? true : false

        const new_txs = res.txs.filter(p => { return !asset.addresses[addrNdx].txs.some(p2 => { return p2.txid === p.txid }) })
        const anyNewTx = new_txs.length > 0
        var new_txs_value 
        if (asset.type === configWallet.WALLET_TYPE_UTXO) {
            new_txs_value = 
                new_txs.reduce((sum,p) => { // utxo vin values that this addr contributed to
                    var txAddrValue = new BigNumber(0)
                    if (p.utxo_vin !== undefined) { // UTXO v2 - skip minimal tx's
                        txAddrValue = p.utxo_vin
                        .filter(p2 => { return p2.addr == asset.addresses[addrNdx] })
                        .map(p2 => { return p2.valueSat })
                        .reduce((sum2,p2) => { return sum2.plus(new BigNumber(p2)) }, new BigNumber(0))
                    }
                    return sum.plus(txAddrValue)
                },
                new BigNumber(0))
        }
        else {
            new_txs_value = 
                new_txs
                .filter(p => { return p.value !== undefined }) // ETH v2 - skip minimal tx's
                .reduce((sum,p) => { 
                    return sum.plus(new BigNumber(utilsWallet.toCalculationUnit(p.value, asset).times(p.isIncoming ? +1 : -1)))
                              .plus(new BigNumber(utilsWallet.toCalculationUnit(p.isIncoming || utilsWallet.isERC20(asset) ? 0 : (new BigNumber(p.fees).times(-1)), asset))) }, new BigNumber(0))
        }
        
        const delta_bal_conf   = new BigNumber(res.balance).minus(new BigNumber(asset.addresses[addrNdx].balance))
        const delta_bal_unconf = new BigNumber(res.unconfirmedBalance).minus(new BigNumber(asset.addresses[addrNdx].unconfirmedBalance))
        const min_accept_delta = asset.addressType === configWallet.ADDRESS_TYPE_ETH ? 1 : configWallet.UTXO_DUST_SAT

        const anyPendingLocalTxs = getAll_local_txs(asset).length > 0

        // if (asset.symbol === 'SD1A_TEST') {
        //     console.log('DBG2 - balanceChanged', balanceChanged)
        //     console.log('DBG2 - anyPendingLocalTxs', anyPendingLocalTxs)
        //     console.log('DBG2 - delta_bal_conf', delta_bal_conf)
        //     console.log('DBG2 - delta_bal_unconf', delta_bal_unconf)
        //     console.log('DBG2 - new_txs.length', new_txs.length)
        //     console.log('DBG2 - new_txs_value', new_txs_value)
        // }
        if (
            // initial load or testing - accept
            firstLoad || testingPaddedTxs                                  
        
            // utxo & account - MAIN ATOMIC UPDATE FILTER -- delta on tx's value and the balance are in sync
            || (balanceChanged && anyNewTx && new_txs_value.minus(delta_bal_conf).abs() <= min_accept_delta)

            // account only (eth) - CASHFLOW TOKENS -- we can get balance updates without *any* transactions!
            //   > this happens when we subscribe to an issuance by sending eth to the CFT contract <
            // in this case, accept a state change on the balance update, but only if there aren't any unconfirmed/pending tx's
            // (the last condition keeps the CFT's working in the normal erc20 receive case [bug otherwise is balance updates to high, then settles to correct value])
            || (asset.isCashflowToken && balanceChanged && anyPendingLocalTxs == false)

            // account - new tx but no balance change -- accept (note we don't accept the inverse)
            // this is to work around blockbook not giving us atomic tx/balance updates;
            //   on receive, get balance update without tx update, which we ignore in favour of our local_tx
            //   accepting the inverse lets us accept the new tx (when BB eventually reports it), in the case where we've just logged in
            //   and are waiting for a lagging BB tx, and firstLoad has already accepted the BB balance
            //|| (asset.type === configWallet.WALLET_TYPE_ACCOUNT && newTx && !balanceChanged)

            //|| (asset.type === configWallet.WALLET_TYPE_ACCOUNT && balanceChanged && newTx)

            //|| (asset.type === configWallet.WALLET_TYPE_ACCOUNT && !delta_bal_conf.eq(0))

            // try BTC send-all issue fix
            // ******
            //|| (asset.type === configWallet.WALLET_TYPE_UTXO)

            // utxo - accept *any* change to confirmed
            //|| (asset.type === configWallet.WALLET_TYPE_UTXO && !delta_bal_conf.eq(0))

            // utxo - accept an unconf change only if it matches tx change
            //|| (asset.type === configWallet.WALLET_TYPE_UTXO && new_txs_value.minus(delta_bal_unconf).abs() <= min_accept_delta) 
        )
        { 
            var newAddr = Object.assign({}, asset.addresses[addrNdx], res)
            newAddr.lastAddrFetchAt = new Date()

            utilsWallet.log(`getAddressFull_ProcessResult - ${asset.symbol} - addrNdx=${addrNdx} - ACCEPTING STATE UPDATE: newTx=${anyNewTx} balanceChanged=${balanceChanged}`) 

            const dispatchAction = { type: actionsWallet.WCORE_SET_ADDRESS_FULL, payload: { updateAt: new Date(), symbol: asset.symbol, newAddr} }
            return dispatchAction
        }
        else {
            //utilsWallet.log(`getAddressFull_ProcessResult - ${asset.symbol} - addrNdx=${addrNdx} - dropping state update! newTx=${newTx}, balanceChanged=${balanceChanged}, new_txs_value=${new_txs_value.toString()}, delta_bal_conf=${delta_bal_conf.toString()}`)
            return null
        }
    },

    // payTo: [ { receiver: 'address', value: 'value'} ... ]
    createAndPushTx: (p, callback) => { 
        const { store, payTo, wallet, asset, feeParams = {}, sendFromAddrNdx = -1, apk, h_mpk } = p

        utilsWallet.log(`*** createAndPushTx (wallet-external) ${asset.symbol}... payTo=`, payTo)

        createTxHex({ payTo,
                      asset,
         encryptedAssetsRaw: wallet.assetsRaw,
                  feeParams,
                   sendMode: true,
            sendFromAddrNdx,
                        apk: apk,
                      h_mpk: h_mpk,
        })
        .then(res => {
            const txHex = res.hex
            pushTransactionHex(store, payTo, wallet, asset, txHex, (res, err) => {
                if (err) {
                    utilsWallet.error(`## createAndPushTx (wallet-external) ${asset.symbol}, err=`, err)
                    callback(null, err)
                }
                else {
                    utilsWallet.logMajor('green','white', `Broadcast txid=${res.tx.txid}`, txHex, { logServerConsole: true })
                    store.dispatch({ type: actionsWallet.WCORE_PUSH_LOCAL_TX, payload: { symbol: asset.symbol, tx: res.tx } }) 
                    callback(res)
                }
            })
        })
        .catch(err => {
            utilsWallet.error(`### createAndPushTx (wallet-external) createTxHex FAILED - ${asset.symbol} err=`, err)
            try {
                let message = err.response.data.errors[0].error
                callback(null, message)
            } catch (_) {
                callback(null, err.message || err.toString())
            }
        })
    },

    exploreAssetAddress: (asset, addrNdx) => {
        if (configExternal.walletExternal_config[asset.symbol] !== undefined) {
            const a_n = asset.addresses[addrNdx]
            const explorer = configExternal.walletExternal_config[asset.symbol].explorerPath(a_n.addr)
            window.open(explorer, '_blank')
        }
    },

    //
    // Combines all txs and local_txs across all addresses
    //
    getAll_txs: (asset) => {
        return getAll_txs(asset)
    },
    getAll_local_txs: (asset) => {
        return getAll_local_txs(asset)
    },
    getAll_unconfirmed_txs: (asset) => {
        return getAll_unconfirmed_txs(asset)
    },

    //
    // Combines local_tx data with tx and balance fields ; two distinct sets of balance data: 
    //
    //    the first (main) set is {conf, unconf, avail, total} - this is top-level "account" data, suitable for main display
    //    for utxo-types, we might be waiting for a change utxo to be returned to us; so we also return { utxo_avail, utxo_changePending } - used by the send screen
    //
    // if no addrNdx supplied, returns aggregated data for all addresses, otherwise restricts to the supplied address index
    //
    get_combinedBalance: (asset, addrNdx = -1) => {
        
        if (asset === undefined || asset.addresses === undefined) return 
        const meta = configWallet.walletsMeta[asset.name.toLowerCase()] 
        var ret = {
                        conf: new BigNumber(0),
                      unconf: new BigNumber(0),
                 pending_out: new BigNumber(0),
                  pending_in: new BigNumber(0),
                 has_pending: false,
                       avail: new BigNumber(0),
                       total: new BigNumber(0),
                //utxo_avail: new BigNumber(0),
        //utxo_changePending: new BigNumber(0),
        unconfirmed_tx_count: 0,
         allAddressesFetched: false,
        }

        // filter all or single address
        var addresses
        if (addrNdx == -1) {
            addresses = asset.addresses
        }
        else {
            addresses = []
            if (asset.addresses[addrNdx])
                addresses.push(asset.addresses[addrNdx])
            else
                return ret
        }

        //console.time(`get_combinedBalance ${asset.symbol}`)

        // confirmed & unconfirmed balances, aggregated over all addresses
        const totalConfirmed = addresses.reduce((sum,p) => { return new BigNumber(p.balance || 0).plus(new BigNumber(sum)) }, 0)
        const totalUnconfirmed = addresses.reduce((sum,p) => { return new BigNumber(p.unconfirmedBalance || 0).plus(new BigNumber(sum)) }, 0)

        if (addresses.some(p => p.balance === undefined || p.unconfirmedBalance === undefined)) {
            ret.allAddressesFetched = false
        }
        else {
            ret.allAddressesFetched = true
        }

        ret.conf = totalConfirmed || new BigNumber(0)
        ret.unconf = totalUnconfirmed || new BigNumber(0)
        
        // we need to supplement address-level unconfirmed data with local_tx data;
        //  (1) eth doesn't give us any concept of unconfirmed
        //  (2) similarly for segwit, our insight node has no knowledge of unconfirmed segwit tx's

        // assign (subtract) sum of pending local txs to unconfirmed balance from external source;
        // see wallet reducer for how local_txs are reconciled/removed as they're fetched from external sources
        var cu_local_txs_pendingOut = 
            asset.local_txs
            .filter(p => p.isIncoming === false || p.sendToSelf === true)

            .filter(p => meta.addressType !== configWallet.ADDRESS_TYPE_ETH
                    || (addresses.some(p2 => p2.addr.toLowerCase() === p.account_from.toLowerCase() )))

            .reduce((sum,p) => {
                var cu_value = utilsWallet.toCalculationUnit(p.value, asset)
                var cu_fees = utilsWallet.toCalculationUnit(p.fees, asset)
                var bn_total = new BigNumber(cu_value).plus(utilsWallet.isERC20(asset) ? 0 : cu_fees)
                return sum.plus(bn_total.times(-1))
            }, new BigNumber(0))

        var cu_local_txs_pendingIn = 
            asset.local_txs
            .filter(p => p.isIncoming === true || p.sendToSelf === true)

            .filter(p => meta.addressType !== configWallet.ADDRESS_TYPE_ETH
                    || (addresses.some(p2 => p2.addr.toLowerCase() === p.account_to.toLowerCase() )))

            .reduce((sum,p) => { 
                var cu_value = utilsWallet.toCalculationUnit(p.value, asset)
                return sum.plus(new BigNumber(cu_value))
            }, new BigNumber(0))

        // modify unconfirmed with sum of pending inbound (+ve) and outbound (-ve)
        ret.unconf = ret.unconf.plus(cu_local_txs_pendingOut) // -ve
        ret.unconf = ret.unconf.plus(cu_local_txs_pendingIn)  // +ve

        // the above modified unconf field can net to zero (if pending in and out values are the same in both directions),
        // so we also return summed pending in and out values:
        ret.pending_out = cu_local_txs_pendingOut
        ret.pending_in = cu_local_txs_pendingIn
        ret.has_pending = cu_local_txs_pendingOut.isLessThan(0) || cu_local_txs_pendingIn.isGreaterThan(0) || totalUnconfirmed != 0

        // available balance: deduct any pending out, don't credit any pending in
        ret.avail = ret.conf.minus(cu_local_txs_pendingOut.abs())                                    // net off any pending local_tx out value
                            .minus(totalUnconfirmed < 0 ? new BigNumber(totalUnconfirmed).abs() : 0) // net off any address (3PBP) pending out value
        
        // total balance: confirmed and unconfirmed
        ret.total = ret.conf.plus(ret.unconf)

        // eth - round dust values to zero (all because can't get Geth to accept precise full-send amounts)
        if (asset.symbol === 'ETH' || asset.symbol === 'ETH_TEST') {
            if (configWallet.ETH_COALESCE_DUST_TO_ZERO && ret.avail.isGreaterThan(0) && ret.avail.isLessThanOrEqualTo(configWallet.ETH_DUST_WEI)) { 
                //utilsWallet.log(`get_combinedBalance - rounding dust (avail) wei for ${asset.symbol} (${ret.avail})`)
                ret.avail = new BigNumber(0)
            }
            if (configWallet.ETH_COALESCE_DUST_TO_ZERO && ret.total.isGreaterThan(0) && ret.total.isLessThanOrEqualTo(configWallet.ETH_DUST_WEI)) { 
                //utilsWallet.log(`get_combinedBalance - rounding dust (total) wei for ${asset.symbol} (${ret.total})`)
                ret.total = new BigNumber(0)
            }
        }

        // TODO -- should also be rounding ERC20 dust values - observed (sometimes) - "1e-20" or similar on send all erc20

        // utxo balance
        /*if (asset.type === configWallet.WALLET_TYPE_UTXO) {
            // BB v3
            // if (asset.symbol === 'BTC_SEG') {
            //     // this is only neeeded for segwit, where insight-api doesn't give us balances reflecting unconfirmed tx's,
            //     // and doesn't update segwit utxo lists for unconfirmed tx's
            //     const utxos_flat = _.flatten(addresses.map(p => { return p.utxos })) 
            //     ret.utxo_avail = 
            //         utxos_flat.reduce((sum, p) => { return sum.plus(new BigNumber(p.satoshis)) }, new BigNumber(0))
            //     const changePending = new BigNumber(ret.avail).minus(new BigNumber(ret.utxo_avail))
            //     ret.utxo_changePending =  changePending.lt(0) ? new BigNumber(0) : changePending // clamp <0
            // }
            // else {
                // for other utxo-types, insight data is fine
                ret.utxo_avail = ret.avail
                ret.utxo_changePending = new BigNumber(0)
            //}
        }
        else {
            ret.utxo_avail = new BigNumber(-1)
            ret.utxo_changePending = new BigNumber(-1)
        }*/

        // get total # of pending tx's -- external and local
        // const all_txs = getAll_txs(asset)
        // const unconfirmed_txs = all_txs.filter(p => { 
        //     return (p.block_no === -1 || p.block_no === undefined || p.block_no === null)
        //         && p.isMinimal === false
        // })
        const unconfirmed_txs = getAll_unconfirmed_txs(asset)
        ret.unconfirmed_tx_count = asset.local_txs.length + unconfirmed_txs.length 

        //console.timeEnd(`get_combinedBalance ${asset.symbol}`)

        //utilsWallet.log(ret)
        return ret
    },

    //
    // Compute a specific tx fee, for the supplied tx details
    //
    computeTxFee: async (p) => { 
        var { asset, receiverAddress, feeData, sendValue, encryptedAssetsRaw, useFastest, useSlowest, apk, h_mpk } = p
        if (!feeData) { throw 'Invalid parameter - feeData' }
        if (!asset) { throw 'Invalid parameter - asset' }
        if (!encryptedAssetsRaw) { throw 'Invalid parameter - encryptedAssetsRaw' }
        if (!apk) { throw 'Invalid parameter - apk' }
        if (!h_mpk) { throw 'Invalid parameter - h_mpk' }

        var ret = {}

        if (asset.type === configWallet.WALLET_TYPE_UTXO) { 

            var cu_satPerKB = useFastest ? feeData.fastest_satPerKB
                            : useSlowest ? feeData.slow_satPerKB
                            :              feeData.fast_satPerKB

            var du_satPerKB = Number(utilsWallet.toDisplayUnit(new BigNumber(cu_satPerKB), asset))
            if (!sendValue) {
                sendValue = 0
            }
            const payTo = [ { receiver: configExternal.walletExternal_config[asset.symbol].donate, value: sendValue } ]
            
            // we need to pass some fee into createTxHex; 
            // we only care here though about the returned tx size data
            const feeParams = { txFee: { fee: (du_satPerKB / 4) } }

            const res = await createTxHex({ 
                payTo, asset, encryptedAssetsRaw, feeParams, sendMode: false, sendFromAddrNdx: -1,
                         apk: apk, 
                       h_mpk: h_mpk,
            })
            if (res !== undefined) {
                const cu_fee = new BigNumber(Math.ceil(((res.byteLength / 1024) * cu_satPerKB))) // tx KB size * sat/KB

                const du_fee = Number(utilsWallet.toDisplayUnit(cu_fee, asset))
                ret = { inputsCount: res.inputsCount,
                         utxo_vsize: res.vSize,
                      utxo_satPerKB: cu_satPerKB,
                    utxo_byteLength: res.byteLength,
                                fee: du_fee }
            }
            else {
                utilsWallet.warn(`Failed to construct tx hex for ${asset.symbol}, payTo=`, payTo)
                throw 'Failed to construct tx - ensure you have sufficient inputs for the specified value'
            }
        }
        else if (asset.type === configWallet.WALLET_TYPE_ACCOUNT) { 

            if (asset.addressType === configWallet.ADDRESS_TYPE_ETH) {
                var gasPriceToUse = useFastest ? feeData.gasprice_fastest 
                                  : useSlowest ? feeData.gasprice_safeLow 
                                  :              feeData.gasprice_fast 
                
                var gasLimitToUse = feeData.gasLimit // default "estimate" - from wallet/actions.getAssetFeeData()

                // erc20's -- if asset flag set: use estimateGas + a multiplier (override hard-coded erc20_transferGasLimit); 
                // required for complex transfer() functions, e.g. cashflow tokens
                //if (erc20) { ...
                if (asset.erc20_gasEstimateMultiplier) {
                    const dummyTxParams = {
                            from: asset.addresses[0].addr, //configExternal.walletExternal_config[asset.symbol].donate, 
                              to: configExternal.walletExternal_config[asset.symbol].donate,
                           value: sendValue,
                        gasLimit: feeData.gasLimit,
                        gasPrice: gasPriceToUse,
                    }
                    utilsWallet.log(`erc20 - dummyTxParams`, dummyTxParams)
                    const dummyTxHex = await walletAccount.createTxHex_Account({ asset, params: dummyTxParams, privateKey: undefined })
                    if (dummyTxHex && dummyTxHex.txParams) {
                        const gasTxEstimate = await walletAccount.estimateTxGas_Account({ asset, params: dummyTxHex.txParams })
                        utilsWallet.log(`erc20 - gasEstimate`, gasTxEstimate)
                        utilsWallet.log(`erc20 - asset`, asset)
                        utilsWallet.log(`erc20 - asset.erc20_gasEstimateMultiplier`, asset.erc20_gasEstimateMultiplier)
                        if (gasTxEstimate && gasTxEstimate > 0) {
                            // use modified web3 gas estimate
                            gasLimitToUse = Math.max(
                                Math.ceil(gasTxEstimate * asset.erc20_gasEstimateMultiplier),
                                asset.erc20_gasMin
                            )

                            utilsWallet.log(`erc20 - estimatedGas`, gasLimitToUse)
                        }
                    }
                    else utilsWallet.warn(`erc20 - failed to get tx params`)
                }

                // eth -- if receiver addr supplied: use estimateGas to override feeData;
                // required for complex payable functions, e.g. cashflow tokens
                if (receiverAddress) {
                    if (utilsWallet.isERC20(receiverAddress)) {
                        if (asset.symbol === 'ETH_TEST' || asset.symbol === 'ETH') {
                            const dummyTxParams = {
                                    from: asset.addresses[0].addr, // ##? will fail if sending from ndx != 0? will need sending index to be passed?
                                      to: receiverAddress,
                                   value: sendValue,
                                gasLimit: 7000000, //feeData.gasLimit,
                                gasPrice: gasPriceToUse,
                            }
                            utilsWallet.log(`eth(_test) - dummyTxParams`, dummyTxParams)
                            const dummyTxHex = await walletAccount.createTxHex_Account({ asset, params: dummyTxParams, privateKey: undefined })
                            if (dummyTxHex && dummyTxHex.txParams) {
                                const gasTxEstimate = await walletAccount.estimateTxGas_Account({ asset, params: dummyTxHex.txParams })
                                utilsWallet.log(`eth(_test) - gasEstimate`, gasTxEstimate)
                                utilsWallet.log(`eth(_test) - asset`, asset)
                                if (gasTxEstimate && gasTxEstimate > 0) {
                                    // use modified web3 gas estimate
                                    gasLimitToUse = Math.ceil(gasTxEstimate * 1.2)
                                    utilsWallet.log(`eth(_test) - estimatedGas`, gasLimitToUse)
                                }
                            }
                            else utilsWallet.warn(`eth(_test) - failed to get tx params`)
                        }
                    }
                }

                // ret
                var du_ethFee = 
                    new BigNumber(gasLimitToUse)
                    .dividedBy(1000000000)
                    .multipliedBy(new BigNumber(gasPriceToUse))
                    .dividedBy(1000000000)
                    .toString()
                ret = { inputsCount: 1,
                       eth_gasLimit: gasLimitToUse,
                       eth_gasPrice: gasPriceToUse,
                                fee: du_ethFee }

                //console.warn(`computeTxFee - feeData=`, feeData)
                //console.warn(`computeTxFee - du_ethFee=${du_ethFee}, ret=`, ret)
            }
            else throw(`Unknown account address type`)
        }
        else throw(`Unknown asset type`)

        utilsWallet.log(`computeTxFee ${asset.symbol} ${sendValue} - ret=`, ret)
        return ret
    },

    //
    // this is called at validation-time on send screen to determine the total vbytes needed for the TX, as well as at send-time;
    // UTXOs are cached in the asset object and form part of the asset's full fetch payload
    //
    createTxHex: (params) => {
        return createTxHex(params)
    },
}

//
// create tx hex - all assets
//
async function createTxHex(params) {
    const { payTo, asset, encryptedAssetsRaw, feeParams, sendMode = true, sendFromAddrNdx = -1,
            apk, h_mpk } = params

    if (!payTo || payTo.length == 0 || !payTo[0].receiver) throw 'Invalid or missing payTo'
    if (payTo.length != 1) throw 'send-many is not supported'
    if (!asset) throw 'Invalid or missing asset'
    if (!feeParams || !feeParams.txFee) throw 'Invalid or missing feeParams'
    if (!encryptedAssetsRaw || encryptedAssetsRaw.length == 0) throw 'Invalid or missing encryptedAssetsRaw'
    if (!apk || apk.length == 0) throw 'Invalid or missing apk'
    if (!h_mpk || h_mpk.length == 0) throw 'Invalid or missing h_mpk'

    utilsWallet.log(`*** createTxHex (wallet-external) ${asset.symbol}...`)
    const validationMode = !sendMode
    const skipSigningOnValidation = true

    // all utxos, across all wallet addresses
    var utxos = []
    asset.addresses.forEach(a_n => utxos.extend(a_n.utxos.map(p => { return Object.assign({}, p, { address: a_n.addr } )})))

    // get private keys
    var pt_AssetsJson = utilsWallet.aesDecryption(apk, h_mpk, encryptedAssetsRaw)
    if (!pt_AssetsJson || pt_AssetsJson === '') throw('Failed decrypting assets')

    var pt_assetsObj = JSON.parse(pt_AssetsJson)
    var pt_asset = pt_assetsObj[asset.name.toLowerCase()]
    utilsWallet.softNuke(pt_assetsObj)
    pt_AssetsJson = null

    // flatten accounts: addr -> privKey
    var addrPrivKeys = []
    pt_asset.accounts.forEach(account => {
        account.privKeys.forEach(privKey => {
            // get addr from wif
            const meta = configWallet.walletsMeta[asset.name.toLowerCase()]  //|| configWallet.walletsMeta[asset.symbol.toLowerCase()] // dbg/temp -- as above

            //const addr = getAddressFromPrivateKey(meta, privKey.privKey, undefined/*eosActiveWallet*/)
            // perf - much faster to lookup the addr rather than recompute it
            const addrInfo = asset.addresses.find(p => p.path === privKey.path)
            if (!addrInfo) {
                utilsWallet.error(`failed to lookup addr for path ${privKey.path}`)
            }

            addrPrivKeys.push( { addr: addrInfo.addr, privKey: privKey.privKey } )  
        })
    })
    utilsWallet.softNuke(pt_asset)

    switch (asset.type) {

        case configWallet.WALLET_TYPE_UTXO: {
            // get total receiver output value, for return
            const cu_sendValue = payTo.reduce((sum,p) => { return sum.plus(new BigNumber(p.value).times(100000000)) }, BigNumber(0))

            // get required inputs & outputs
            const utxoParams = {
                changeAddress: asset.addresses[0].addr, // all change to primary address -- todo: probably should use new address on every send here
                      outputs: payTo.map(p => { return { receiver: p.receiver, value: new BigNumber(p.value).times(100000000).toString() }}),
                  feeSatoshis: Math.floor(feeParams.txFee.fee * 100000000),
                        utxos, // flattened list of all utxos across all addresses
            }
            var txSkeleton
            try {
                txSkeleton = await walletUtxo.getUtxo_InputsOutputs(asset.symbol, utxoParams) //, true /*sendMode*/) //throwOnInsufficient
            }
            catch (err) {
                if (sendMode) return Promise.reject(err) // we're sending a tx: the error will propagate to client
                else          return undefined           // we're estimating fees for a tx: the error will be handled internally
            }
            if (!txSkeleton) throw 'Failed parsing tx skeleton'

            //console.time('ext-createTxHex-utxo-createSignTx')
                const opsWallet = require('./wallet')
                const network = opsWallet.getUtxoNetwork(asset.symbol)
                
                var tx, hex, vSize, byteLength
                if (asset.symbol === 'ZEC' || asset.symbol === 'DASH' || asset.symbol === 'VTC'
                || asset.symbol === 'QTUM' || asset.symbol === 'DGB' || asset.symbol === 'BCHABC'
                || asset.symbol === 'ZEC_TEST'
                || asset.symbol === 'RVN')
                {
                    if (asset.symbol === 'ZEC' || asset.symbol === 'ZEC_TEST') {
                        //network.consensusBranchId["4"] = 4122551051 // 0xf5b9230b -- Heartwood -- https://github.com/BitGo/bitgo-utxo-lib/releases/tag/1.7.1
                        network.consensusBranchId["4"] = 3925833126 // 0xe9ff75a6 -- Canopy
                    }
                    utilsWallet.log(`createTxHex - network`, network)

                    //
                    // UTXO - bitgo-utxo tx builder (https://github.com/BitGo/bitgo-utxo-lib/issues/12, https://blog.bitgo.com/how-to-create-a-zcash-sapling-compatible-multisig-transaction-98e45657c48d )
                    //
                    const txb = new bitgoUtxoLib.TransactionBuilder(network)
                    if (asset.symbol === 'ZEC' || asset.symbol === 'ZEC_TEST') {
                        txb.setVersion(bitgoUtxoLib.Transaction.ZCASH_SAPLING_VERSION) // sapling: v4
                        txb.setVersionGroupId(2301567109) // sapling
                        txb.setExpiryHeight(0) // if non-zero, will be removed from mempool at this block height, if not yet mined
                    }
                    
                    // add the outputs
                    txSkeleton.outputs.forEach(output => {
                        //utilsWallet.log(output)

                        var outputAddress = output.address

                        // bcash - remove prefix from cash addr from inputs and outputs, and convert to legacy 1 addr's
                        if (asset.symbol === 'BCHABC') {
                            if (outputAddress.startsWith("bitcoincash:")) {
                                outputAddress = bchAddr.toLegacyAddress(outputAddress.substring("bitcoincash:".length)) 
                            }
                            if (outputAddress.startsWith("q") || outputAddress.startsWith("C")) { // q or C - bch cash-addr or bch "bitpay" addr
                                outputAddress = bchAddr.toLegacyAddress(outputAddress)
                            }
                        }

                        txb.addOutput(outputAddress, Number(Number(output.value).toFixed(0)))
                    })
                    
                    // run faster when in validation mode (not sending for real) - skip signing, return incomplete tx and estimate final vsize
                    const inc_tx = txb.buildIncomplete()
                    const inc_vs = inc_tx.virtualSize()
                    const inc_bl = inc_tx.byteLength()
                    utilsWallet.log('inc_tx.virtualSize=', inc_vs)
                    utilsWallet.log('inc_tx.byteLength=', inc_bl)
                    if (validationMode && skipSigningOnValidation) { // validation mode
                        vSize = inc_vs + (asset.tx_perInput_vsize * txSkeleton.inputs.length) 
                        byteLength = inc_bl + (asset.tx_perInput_byteLength * txSkeleton.inputs.length)
                        tx = inc_tx
                    }
                    else { // exec mode

                        // add the inputs
                        for (var i = 0; i < txSkeleton.inputs.length; i++) {
                            utilsWallet.log(`${asset.symbol} TX input #${i} UTXO txid ${txSkeleton.inputs[i].utxo.txid} - input=`, txSkeleton.inputs[i])
                            txb.addInput(txSkeleton.inputs[i].utxo.txid, txSkeleton.inputs[i].utxo.vout)
                        }

                        // sign the inputs - SLOW!
                        for (var i = 0; i < txSkeleton.inputs.length; i++) {
                            var wif = addrPrivKeys.find(p => { return p.addr === txSkeleton.inputs[i].utxo.address }).privKey
                            var keyPair = bitgoUtxoLib.ECPair.fromWIF(wif, network)
                            if (asset.symbol === 'ZEC' || asset.symbol === 'ZEC_TEST') {
                                txb.sign(i, keyPair, '', bitgoUtxoLib.Transaction.SIGHASH_SINGLE, txSkeleton.inputs[i].utxo.satoshis) // zec requires more data to sign
                            }
                            else if (asset.symbol === 'BCHABC') {
                                txb.sign(i,
                                    keyPair, '',
                                    bitgoUtxoLib.Transaction.SIGHASH_ALL | bitgoUtxoLib.Transaction.SIGHASH_BITCOINCASHBIP143,
                                    txSkeleton.inputs[i].utxo.satoshis) 
                            }
                            else { 
                                txb.sign(i, keyPair)
                            }
                            
                            utilsWallet.softNuke(keyPair)
                            utilsWallet.softNuke(wif)
                        }

                        // complete tx
                        tx = txb.build()
                        const tx_vs = tx.virtualSize()
                        vSize = tx_vs
                        const tx_bl = tx.byteLength()
                        byteLength = tx_bl
                        utilsWallet.log('tx.virtualSize=', tx_vs)
                        utilsWallet.log('tx.byteLength=', tx_bl)
                        
                        // dbg
                        const delta_vs = tx_vs - inc_vs
                        const delta_vs_perInput = delta_vs / txSkeleton.inputs.length
                        utilsWallet.log('dbg: delta_vs=', delta_vs)
                        utilsWallet.log('dbg: delta_vs_perInput=', delta_vs_perInput)

                        const delta_bl = tx_bl - inc_bl
                        const delta_bl_perInput = delta_bl / txSkeleton.inputs.length
                        utilsWallet.log('dbg: delta_bl=', delta_bl)
                        utilsWallet.log('dbg: delta_bl_perInput=', delta_bl_perInput)

                        hex = tx.toHex()
                        utilsWallet.log(`*** createTxHex (wallet-external UTXO bitgo-utxo) ${asset.symbol}, hex.length, hex=`, hex.length, hex)
                    }
                }
                else {
                    //
                    // UTXO - bitcoin-js tx builder
                    //
                    const txb = new bitcoinJsLib.TransactionBuilder(network)

                    // add the outputs
                    txb.setVersion(1)
                    txSkeleton.outputs.forEach(output => {
                        utilsWallet.log(output)
                        txb.addOutput(output.address, Number(Number(output.value).toFixed(0)))
                    })

                    // validation mode - compute base vSize for skeleton tx (with fixed two outputs)
                    const inc_tx = txb.buildIncomplete()
                    const inc_vs = inc_tx.virtualSize()
                    const inc_bl = inc_tx.byteLength()
                    utilsWallet.log('inc_tx.virtualSize=', inc_vs)
                    utilsWallet.log('inc_tx.byteLength=', inc_bl)
                    if (validationMode && skipSigningOnValidation) { // validation mode
                        vSize = inc_vs + (asset.tx_perInput_vsize * txSkeleton.inputs.length) 
                        byteLength = inc_bl + (asset.tx_perInput_byteLength * txSkeleton.inputs.length)
                        tx = inc_tx
                    }
                    else { // exec mode

                        // add the inputs
                        for (var i = 0; i < txSkeleton.inputs.length; i++) {
                            utilsWallet.log(`${asset.symbol} UTXO TX - input=`, txSkeleton.inputs[i])

                            if (asset.symbol === "BTC_SEG2") {
                                // https://github.com/bitcoinjs/bitcoinjs-lib/issues/999
                                var wif = addrPrivKeys.find(p => { return p.addr === txSkeleton.inputs[i].utxo.address }).privKey
                                var keyPair = bitcoinJsLib.ECPair.fromWIF(wif, network)
                                
                                const scriptPubKey = bitcoinJsLib.payments.p2wpkh({ pubkey: keyPair.publicKey }).output;
                                txb.addInput(txSkeleton.inputs[i].utxo.txid, txSkeleton.inputs[i].utxo.vout, null, scriptPubKey)

                                utilsWallet.softNuke(keyPair)
                                utilsWallet.softNuke(wif)
                            }
                            else {
                                txb.addInput(txSkeleton.inputs[i].utxo.txid, txSkeleton.inputs[i].utxo.vout)
                            }
                        }

                        if (asset.symbol === "BTC_SEG") {
                            for (var i = 0; i < txSkeleton.inputs.length; i++) {
                                var wif = addrPrivKeys.find(p => { return p.addr === txSkeleton.inputs[i].utxo.address }).privKey
                                var keyPair = bitcoinJsLib.ECPair.fromWIF(wif, network)

                                const p2wpkh = bitcoinJsLib.payments.p2wpkh({ pubkey: keyPair.publicKey, network })
                                const p2sh = bitcoinJsLib.payments.p2sh({ redeem: p2wpkh, network })
                                txb.sign(i, keyPair, p2sh.redeem.output, null, txSkeleton.inputs[i].utxo.satoshis)

                                utilsWallet.softNuke(keyPair)
                                utilsWallet.softNuke(wif)
                            }
                        }
                        else if (asset.symbol === "BTC_SEG2") {
                            for (var i = 0; i < txSkeleton.inputs.length; i++) {
                                var wif = addrPrivKeys.find(p => { return p.addr === txSkeleton.inputs[i].utxo.address }).privKey
                                var keyPair = bitcoinJsLib.ECPair.fromWIF(wif, network)

                                txb.sign(i, keyPair, null, null, txSkeleton.inputs[i].utxo.satoshis)

                                utilsWallet.softNuke(keyPair)
                                utilsWallet.softNuke(wif)
                            }
                        }
                        else {
                            for (var i = 0; i < txSkeleton.inputs.length; i++) {
                                var wif = addrPrivKeys.find(p => { return p.addr === txSkeleton.inputs[i].utxo.address }).privKey
                                var keyPair = bitcoinJsLib.ECPair.fromWIF(wif, network)
            
                                txb.sign(i, keyPair)

                                utilsWallet.softNuke(keyPair)
                                utilsWallet.softNuke(wif)
                            }
                        }

                        // complete tx
                        tx = txb.build()
                        const tx_vs = tx.virtualSize()
                        vSize = tx_vs
                        const tx_bl = tx.byteLength()
                        byteLength = tx_bl
                        utilsWallet.log('tx.virtualSize=', tx_vs) 
                        utilsWallet.log('tx.byteLength=', tx_bl) 

                        // dbg
                        const delta_vs = tx_vs - inc_vs
                        const delta_vs_perInput = delta_vs / txSkeleton.inputs.length
                        utilsWallet.log('dbg: delta_vs=', delta_vs)
                        utilsWallet.log('dbg: delta_vs_perInput=', delta_vs_perInput) 

                        const delta_bl = tx_bl - inc_bl
                        const delta_bl_perInput = delta_bl / txSkeleton.inputs.length
                        utilsWallet.log('dbg: delta_bl=', delta_bl)
                        utilsWallet.log('dbg: delta_bl_perInput=', delta_bl_perInput)
                        
                        hex = tx.toHex()
                        utilsWallet.log(`*** createTxHex (wallet-external UTXO bitcoin-js) ${asset.symbol}, hex.length, hex=`, hex.length, hex)
                    }
                }
            //console.timeEnd('ext-createTxHex-utxo-createSignTx')
            
            utilsWallet.softNuke(addrPrivKeys)
            return new Promise((resolve, reject) => { resolve({ 
                            hex, 
                          vSize,
                     byteLength,
                    inputsCount: txSkeleton.inputs.length, 
                  _cu_sendValue: cu_sendValue.toString(),
                   get cu_sendValue() {
                       return this._cu_sendValue;
                   },
                   set cu_sendValue(value) {
                       this._cu_sendValue = value;
                   },
            }) }) 
        }

        case configWallet.WALLET_TYPE_ACCOUNT: {

            const receiver = payTo[0].receiver
            const value = payTo[0].value

            if (sendFromAddrNdx < 0 || sendFromAddrNdx > asset.addresses.length - 1) {
                utilsWallet.error(`### createTxHex (wallet-external ACCOUNT) ${asset.symbol} - bad addrNdx supplied`)
                return new Promise((resolve, reject) => { reject('Bad addrNdx') })
            }

            const senderAddr = asset.addresses[sendFromAddrNdx].addr
            var wif = addrPrivKeys.find(p => { return p.addr === senderAddr }).privKey

            payTo.senderAddr = senderAddr // record sender -- it's passed through post-tx send and is recorded on the local_tx

            const txParams = {
                from: senderAddr, 
                  to: receiver,
               value: value,
            gasLimit: feeParams.txFee.eth_gasLimit,
            gasPrice: feeParams.txFee.eth_gasPrice,
            }
        
            const walletAccount = require('./wallet-account')
            const txHexAndValue = await walletAccount.createTxHex_Account({ asset, params: txParams, privateKey: wif })
            //console.log('DBG1 - txHexAndValue', txHexAndValue)
            //utilsWallet.log(`*** createTxHex (wallet-external ACCOUNT) ${asset.symbol}, txParams=`, txParams)
            //utilsWallet.log(`*** createTxHex (wallet-external ACCOUNT) ${asset.symbol}, hex=`, txHexAndValue.hex)
            //utilsWallet.log(`*** createTxHex (wallet-external ACCOUNT) ${asset.symbol}, cu_sendValue=`, txHexAndValue.cu_sendValue)
            //utilsWallet.log(`*** createTxHex (wallet-external ACCOUNT) ${asset.symbol}, cu_sendValue.toString()=`, txHexAndValue.cu_sendValue.toString())

            utilsWallet.softNuke(addrPrivKeys)
            return new Promise((resolve, reject) => { 
                resolve( { hex: txHexAndValue.txhex, 
                  cu_sendValue: txHexAndValue.cu_sendValue.toString() }
                )})
        }

        default:
            utilsWallet.error('Wallet type ' + asset.type + ' not supported!')
            break
    }
}

//
// push tx
// 
function pushTransactionHex(store, payTo, wallet, asset, txHex, callback) {
    utilsWallet.log(`*** pushTransactionHex (wallet-external) ${asset.symbol} txHex=`, txHex)

    switch (asset.type) {
        case configWallet.WALLET_TYPE_UTXO:
            walletUtxo.pushRawTransaction_Utxo(wallet, asset, txHex, (res, err) => {
                callback(res, err)
            })
            break

        case configWallet.WALLET_TYPE_ACCOUNT:
            walletAccount.pushRawTransaction_Account(store, asset, payTo, txHex, (res, err) => {
                callback(res, err)
            })
            break
                
        default:
            throw 'Unsupported asset type'
    }
}

//
// consolidated tx's (across all addresses)
//
function getAll_txs(asset) {
    
    // dedupe send-to-self tx's (present against >1 address)
    var all_txs = []
    for(var i=0 ; i < asset.addresses.length ; i++) {
        const addr = asset.addresses[i]
        var existing_txids = all_txs.map(p2 => { return p2.txid } )
        if (addr.txs) {
            var deduped = addr.txs
                //.filter(p => { return p.value !== 0 })
                .filter(p => { return !existing_txids.some(p2 => p2 === p.txid) }) // dedupe
            all_txs.extend(deduped)
        }
    }
    all_txs.sort((a,b) => { 
        // sort by block desc, except unconfirmed tx's on top
        const a_block_no = a.block_no !== -1 ? a.block_no : Number.MAX_SAFE_INTEGER
        const b_block_no = b.block_no !== -1 ? b.block_no : Number.MAX_SAFE_INTEGER
        return b_block_no - a_block_no
    })
    return all_txs 
}

function getAll_local_txs(asset) {
    var all_local_txs = asset.local_txs
    all_local_txs.sort((a,b) => { return b.block_no - new Date(a.date) })
    return all_local_txs 
}

function getAll_unconfirmed_txs(asset) {
    const all_txs = getAll_txs(asset)
    const unconfirmed_txs = all_txs.filter(p => { 
        return (p.block_no === -1 || p.block_no === undefined || p.block_no === null)
            && p.isMinimal === false
    })
    return unconfirmed_txs
}

//
// test/dbg
//
function testPadTxs(res) {
    for (let i=0 ; i < configWallet.TEST_PAD_TXS ; i++) {
        res.txs.push( { 
            block_no: 1452313,
            sendToSelf: false,
            confirmed: true,
            date: new Date().toString(),
            fees: 0.00001,
            isIncoming: false,
            toOrFrom: "mkjxRwEFtvW7WBVcwodEPNrHKfESdTsNT5",
            txid: `TEST_TX_${i}`,
            value: "0.42424242",
            utxo_vin: [],
            utxo_vout: [],
        } )
    }
}
