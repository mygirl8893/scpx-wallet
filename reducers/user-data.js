const _ = require('lodash')
import update from 'immutability-helper'

import { userData_SaveAll } from '../actions/user-data'
import { getUserData_FromEncryptedJson } from '../actions/user-data-helpers'
import { USERDATA_UPDATE_OPTION, USERDATA_UPDATE_FBASE, USERDATA_SET_FROM_SERVER } from '../actions'
    
import {
    XS_SET_EXCHANGE_ASSET, XS_SET_RECEIVE_ASSET, 
    XS_SET_MINMAX_AMOUNT,
    XS_SET_EST_RECEIVE_AMOUNT, XS_SET_FIXED_RECEIVE_AMOUNT,
    XS_UPDATE_EXCHANGE_TX,
    XS_SET_CURRENCIES
} from '../actions'

import * as utilsWallet from '../utils'

const { createReducer } = require('./utils')

export const initialState = {
    t_f3: "42-def1",
    t_f4: "42-def2",

    fbaseCloudLoginSaved: {
        email: null,
        photoURL: null,
    },

    // user app settings
    options: [
        { key: "OPT_CLOUD_PWD",   value: false },
        { key: "OPT_AUTOLOGOUT",  value: true },
        { key: "OPT_NIGHTSHIFT",  value: true },
        { key: "OPT_NOPATCH_MPK", value: true },
        { key: "OPT_BETA_TESTER", value: true },
    ],

    // exchange service - current and history records
    exchange: {
        // UI "active" - really should be state in Exchange screen
        cur_fromSymbol: undefined,
        cur_toSymbol: undefined,
        cur_minAmount: 0.00,
        cur_maxAmount: 0.00,
        cur_fixedRateId: undefined,
        cur_estReceiveAmount: 0.00,
        
        // transient - 3PXS current states
        currencies: [],

        cur_xsTx: {
            //...
        }, 
            // todo: -> cur_xsTx.eth -> cur_xsTx.eth[] -- i.e. functions as current and history
            // * creating new --> append only (not replace) ...
            // * updating     --> find, update in place
            // * removing     --> nop

        //cur_xsTxStatus: {}, // todo: -> either remove, or couple into cur_xsTx[asset][i].cur_xsTxStatus
    }
}

const handlers = {
    
    // user settings (options)
    [USERDATA_UPDATE_OPTION]: (state, action) => {
        var ndx = state.options.findIndex((p) => p.key === action.key)
        
        // disregard actions that originate from a different logged on user (this action is propagated by redux-state-sync)
        if (action.payload.owner === utilsWallet.getStorageContext().owner) { 
            var newUserData = update(state, {
                options: {
                    [ndx]: {
                        value: { $set: action.payload.newValue }
                    }
                }
            })
            userData_SaveAll({ userData: newUserData, hideToast: false })
            return newUserData
        }
    },

    // fbase logged-in status
    [USERDATA_UPDATE_FBASE]: (state, action) => {

        var newUserData = update(state, {
            fbaseCloudLoginSaved: {  email: { $set: action.payload.email },
                                  photoURL: { $set: action.payload.photoURL } }
         })

        userData_SaveAll({ userData: newUserData, hideToast: false })
        return newUserData 
    },

    [USERDATA_SET_FROM_SERVER]: (state, action) => { 
        var dataJson = action.dataJson
        
        if (dataJson !== undefined && dataJson !== "" && dataJson.length > 0) {
            
            var serverUserData = getUserData_FromEncryptedJson(dataJson)
            if (!serverUserData) { // sanity check -- have seen corrupted settings saved to server during dev cycles; ignore if so
                return state
            }

            // don't nuke local options from server, instead merge
            var mergedOptions = {...state.options, ...serverUserData.options} // server wins on conflict (right hand side of spread operator)
            var mergedOptionsArray = Array.from(Object.values(mergedOptions))

            // also merge top level fields of settings, so we can add new fields anytime on client and they get preserved on server
            var newUserData = {...state, ...serverUserData} // server wins on conflict
            newUserData.options = mergedOptionsArray 

            userData_SaveAll({ userData: newUserData, hideToast: action.hideToast })
            return newUserData
        }
    },

    //
    // exchange service (XS)
    //
    [XS_SET_EXCHANGE_ASSET]: (state, action) => {
        utilsWallet.logMajor('orange','black', `XS_SET_EXCHANGE_ASSET`, action.payload, { logServerConsole: true })
        return {...state, exchange: {...state.exchange, cur_fromSymbol: action.payload } }
    },
    [XS_SET_RECEIVE_ASSET]: (state, action) => {
        utilsWallet.logMajor('orange','black', `XS_SET_RECEIVE_ASSET`, action.payload, { logServerConsole: true })
        return {...state, exchange: {...state.exchange, cur_toSymbol: action.payload } }
    },

    [XS_SET_MINMAX_AMOUNT]: (state, action) => {
        utilsWallet.logMajor('orange','black', `XS_SET_MINMAX_AMOUNT`, action.payload, { logServerConsole: true })
        return {...state, exchange: {...state.exchange, 
            cur_minAmount: action.payload.min,
            cur_maxAmount: action.payload.max,
         cur_minAmountErr: undefined
        } }
    },

    [XS_SET_EST_RECEIVE_AMOUNT]: (state, action) => {
        utilsWallet.logMajor('orange','black', `XS_SET_EST_RECEIVE_AMOUNT`, action.payload, { logServerConsole: true })
        return {...state, exchange: {...state.exchange, 
            cur_estReceiveAmount: action.payload.result,
                 cur_fixedRateId: undefined
        } }
    },
    [XS_SET_FIXED_RECEIVE_AMOUNT]: (state, action) => {
        utilsWallet.logMajor('orange','black', `XS_SET_FIXED_RECEIVE_AMOUNT`, action.payload, { logServerConsole: true })
        return {...state, exchange: {...state.exchange, 
            cur_estReceiveAmount: action.payload.derivedExpected, 
                 cur_fixedRateId: action.payload.rateId
        }}
    },

    [XS_UPDATE_EXCHANGE_TX]: (state, action) => {
        if (action.payload.owner === utilsWallet.getStorageContext().owner) { // redux-state-sync
            utilsWallet.logMajor('orange','black', `XS_UPDATE_EXCHANGE_TX`, action.payload, { logServerConsole: true })

            var newUserData = _.cloneDeep(state)
            const asset = Object.keys(action.payload.data)[0]
            newUserData.exchange.cur_xsTx[asset] = {...newUserData.exchange.cur_xsTx[asset], ...action.payload.data[asset] }

            userData_SaveAll({ userData: newUserData, hideToast: true })
            return newUserData
        }
    },

    [XS_SET_CURRENCIES]: (state, action) => {
        utilsWallet.logMajor('orange','black', `XS_SET_CURRENCIES`, action.payload, { logServerConsole: true })
        return {...state, exchange: {...state.exchange, 
            currencies: action.payload
        } }
    },
}

export default createReducer(initialState, handlers)

