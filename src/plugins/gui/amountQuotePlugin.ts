import { div, eq, gt, toFixed } from 'biggystring'
import { asNumber, asObject } from 'cleaners'
import { sprintf } from 'sprintf-js'

import { ENV } from '../../env'
import { formatNumber, isValidInput } from '../../locales/intl'
import { lstrings } from '../../locales/strings'
import { config } from '../../theme/appConfig'
import { EdgeTokenId } from '../../types/types'
import { getPartnerIconUri } from '../../util/CdnUris'
import { getTokenId } from '../../util/CurrencyInfoHelpers'
import { fetchInfo } from '../../util/network'
import { logEvent } from '../../util/tracking'
import { fuzzyTimeout } from '../../util/utils'
import { FiatPlugin, FiatPluginFactory, FiatPluginFactoryArgs, FiatPluginGetMethodsResponse, FiatPluginStartParams } from './fiatPluginTypes'
import { FiatProvider, FiatProviderAssetMap, FiatProviderGetQuoteParams, FiatProviderQuote } from './fiatProviderTypes'
import { createStore, getBestError, getRateFromQuote } from './pluginUtils'
import { banxaProvider } from './providers/banxaProvider'
import { bityProvider } from './providers/bityProvider'
import { moonpayProvider } from './providers/moonpayProvider'
import { simplexProvider } from './providers/simplexProvider'

// A map keyed by provider pluginIds, and values representing preferred priority
// for that provider.
// Higher numbers are preferred over lower. If a provider is not listed or is
// marked with a priority of 0, it is not considered for quoting.
const asProviderPriorityMap = asObject(asNumber)
type ProviderPriorityMap = ReturnType<typeof asProviderPriorityMap>

// A map keyed by supported payment types and values of ProviderPriorityMap
const asPaymentTypeProviderPriorityMap = asObject(asProviderPriorityMap)
type PaymentTypeProviderPriorityMap = ReturnType<typeof asPaymentTypeProviderPriorityMap>

type PriorityArray = Array<{ [pluginId: string]: boolean }>

const providerFactories = [bityProvider, simplexProvider, moonpayProvider, banxaProvider]

export const amountQuoteFiatPlugin: FiatPluginFactory = async (params: FiatPluginFactoryArgs) => {
  const { account, disablePlugins, guiPlugin, showUi } = params
  const { pluginId } = guiPlugin

  const assetPromises: Array<Promise<FiatProviderAssetMap>> = []
  const providerPromises: Array<Promise<FiatProvider>> = []

  const fiatPlugin: FiatPlugin = {
    pluginId,
    startPlugin: async (params: FiatPluginStartParams) => {
      const { direction, regionCode, paymentTypes, providerId } = params
      // TODO: Address 'paymentTypes' vs 'paymentType'. Both are defined in the
      // buy/sellPluginList.jsons.
      if (paymentTypes.length === 0) console.warn('No payment types given to FiatPlugin: ' + pluginId)

      let providerPriority: PaymentTypeProviderPriorityMap = {}
      let priorityArray: PriorityArray = [{}]
      if (paymentTypes.length === 1) {
        // Fetch provider priorities from the info server based on the payment
        // type
        try {
          const response = await fetchInfo(`v1/fiatPluginPriority/${config.appId ?? 'edge'}`)
          providerPriority = asPaymentTypeProviderPriorityMap(await response.json())
          priorityArray = createPriorityArray(providerPriority[paymentTypes[0]])
        } catch (e: any) {
          console.warn('Failed to fetch provider priorities:', e)
          // This is ok. We will use all configured providers at equal priority.
        }
      } else {
        throw new Error('Multiple paymentTypes not implemented')
      }

      // Filter providers for which API keys are set and are not explicitly
      // disabled by disablePlugins.
      // TODO: Address redundancy of plugin-disabling implementations: info
      // server vs disablePlugins
      for (const providerFactory of providerFactories) {
        if (disablePlugins[providerFactory.pluginId]) continue
        priorityArray[0][providerFactory.pluginId] = true

        // @ts-expect-error
        const apiKeys = ENV.PLUGIN_API_KEYS[providerFactory.pluginId]
        if (apiKeys == null) continue

        const store = createStore(providerFactory.storeId, account.dataStore)
        providerPromises.push(providerFactory.makeProvider({ io: { store }, apiKeys }))
      }

      if (providerPromises.length === 0) throw new Error('No enabled amountQuoteFiatPlugin providers')

      // Fetch supported assets from all providers
      // TODO: Filter by supported paymentTypes
      const providers = await Promise.all(providerPromises)
      for (const provider of providers) {
        assetPromises.push(provider.getSupportedAssets())
      }

      const ps = fuzzyTimeout(assetPromises, 5000).catch(e => [])
      const assetArray = await showUi.showToastSpinner(lstrings.fiat_plugin_fetching_assets, ps)

      const allowedAssets: EdgeTokenId[] = []
      const allowedFiats: { [fiatCurrencyCode: string]: boolean } = {}
      for (const assetMap of assetArray) {
        if (assetMap == null) continue
        for (const currencyPluginId in assetMap.crypto) {
          const currencyCodeMap = assetMap.crypto[currencyPluginId]
          for (const currencyCode in currencyCodeMap) {
            if (currencyCodeMap[currencyCode]) {
              try {
                const currencyTokenId = getTokenId(account, currencyPluginId, currencyCode)
                allowedAssets.push({ pluginId: currencyPluginId, tokenId: currencyTokenId })
              } catch (e: any) {
                // This is ok. We might not support a specific pluginId
              }
            }
          }
          for (const fiatCode in assetMap.fiat) {
            allowedFiats[fiatCode] = true
          }
        }
      }

      // Pop up modal to pick wallet/asset
      // TODO: Filter wallets according to fiats supported by allowed providers
      const walletListResult: { walletId: string | undefined; currencyCode: string | undefined } = await showUi.walletPicker({
        headerTitle: lstrings.fiat_plugin_select_asset_to_purchase,
        allowedAssets,
        showCreateWallet: true
      })

      const { walletId, currencyCode } = walletListResult
      if (walletId == null || currencyCode == null) return

      const coreWallet = account.currencyWallets[walletId]
      const currencyPluginId = coreWallet.currencyInfo.pluginId
      if (!coreWallet) return await showUi.showError(new Error(`Missing wallet with ID ${walletId}`))

      let counter = 0
      let bestQuote: FiatProviderQuote | undefined
      let goodQuotes: FiatProviderQuote[] = []

      // HACK: Force EUR for sepa Bity, since Bity doesn't accept USD, a common
      // wallet fiat selection regardless of region.
      // TODO: Remove when Fiat selection is designed.
      const fiatCurrencyCode = paymentTypes[0] === 'sepa' ? 'iso:EUR' : coreWallet.fiatCurrencyCode
      const displayFiatCurrencyCode = fiatCurrencyCode.replace('iso:', '')
      const isBuy = direction === 'buy'

      let enterAmountMethods: FiatPluginGetMethodsResponse
      // Navigate to scene to have user enter amount
      showUi.enterAmount({
        headerTitle: isBuy ? sprintf(lstrings.fiat_plugin_buy_currencycode, currencyCode) : sprintf(lstrings.fiat_plugin_sell_currencycode_s, currencyCode),
        isBuy,
        label1: sprintf(lstrings.fiat_plugin_amount_currencycode, displayFiatCurrencyCode),
        label2: sprintf(lstrings.fiat_plugin_amount_currencycode, currencyCode),
        initialAmount1: '500',
        getMethods: (methods: FiatPluginGetMethodsResponse) => {
          enterAmountMethods = methods
        },
        convertValue: async (sourceFieldNum: number, value: string): Promise<string | undefined> => {
          if (!isValidInput(value)) {
            if (enterAmountMethods != null)
              enterAmountMethods.setStatusText({ statusText: lstrings.create_wallet_invalid_input, options: { textType: 'error' } })
            return
          }
          bestQuote = undefined
          goodQuotes = []
          if (eq(value, '0')) return ''
          const myCounter = ++counter
          let quoteParams: FiatProviderGetQuoteParams
          let sourceFieldCurrencyCode

          // TODO: Design UX that supports quoting fiatCurrencyCodes that differ
          // from the the selected wallet's fiatCurrencyCode
          if (sourceFieldNum === 1) {
            // User entered a fiat value. Convert to crypto
            sourceFieldCurrencyCode = displayFiatCurrencyCode
            quoteParams = {
              pluginId: currencyPluginId,
              displayCurrencyCode: currencyCode,
              exchangeAmount: value,
              fiatCurrencyCode,
              amountType: 'fiat',
              direction,
              paymentTypes,
              regionCode
            }
          } else {
            // User entered a crypto value. Convert to fiat
            sourceFieldCurrencyCode = currencyCode
            quoteParams = {
              pluginId: currencyPluginId,
              displayCurrencyCode: currencyCode,
              exchangeAmount: value,
              fiatCurrencyCode,
              amountType: 'crypto',
              direction,
              paymentTypes,
              regionCode
            }
          }

          const quotePromises = providers.filter(p => (providerId == null ? true : providerId === p.pluginId)).map(async p => await p.getQuote(quoteParams))
          let errors: unknown[] = []
          const quotes = await fuzzyTimeout(quotePromises, 5000).catch(e => {
            errors = e
            return []
          })

          // Only update with the latest call to convertValue
          if (myCounter !== counter) return

          for (const quote of quotes) {
            if (quote.direction !== direction) continue
            if (providerPriority[pluginId] != null && providerPriority[pluginId][quote.pluginId] <= 0) continue
            goodQuotes.push(quote)
          }

          if (goodQuotes.length === 0) {
            // Find the best error to surface
            const bestErrorText = getBestError(errors as any, sourceFieldCurrencyCode) ?? lstrings.fiat_plugin_buy_no_quote
            if (enterAmountMethods != null) enterAmountMethods.setStatusText({ statusText: bestErrorText, options: { textType: 'error' } })
            return
          }

          // Find best quote factoring in pluginPriorities
          bestQuote = getBestQuote(goodQuotes, priorityArray ?? [{}])
          if (bestQuote == null) {
            if (enterAmountMethods != null) enterAmountMethods.setStatusText({ statusText: lstrings.fiat_plugin_buy_no_quote, options: { textType: 'error' } })
            return
          }

          const exchangeRateText = getRateFromQuote(bestQuote, displayFiatCurrencyCode)
          if (enterAmountMethods != null) {
            const poweredByOnClick = async () => {
              // 1. Show modal with all the valid quotes
              const items = goodQuotes.map(quote => {
                let text
                if (sourceFieldNum === 1) {
                  // User entered a fiat value. Show the crypto value per partner
                  const localeAmount = formatNumber(toFixed(quote.cryptoAmount, 0, 6))
                  text = `(${localeAmount} ${quote.displayCurrencyCode})`
                } else {
                  // User entered a crypto value. Show the fiat value per partner
                  const localeAmount = formatNumber(toFixed(quote.fiatAmount, 0, 2))
                  text = `(${localeAmount} ${quote.fiatCurrencyCode.replace('iso:', '')})`
                }
                const out = {
                  text,
                  name: quote.pluginDisplayName,
                  icon: getPartnerIconUri(quote.partnerIcon)
                }
                return out
              })
              const rowName = await showUi.listModal({
                title: 'Providers',
                selected: bestQuote?.pluginDisplayName ?? '',
                items
              })
              if (bestQuote == null) return

              // 2. Set the best quote to the one chosen by user (if any is chosen)
              if (rowName != null && rowName !== bestQuote.pluginDisplayName) {
                bestQuote = goodQuotes.find(quote => quote.pluginDisplayName === rowName)
                if (bestQuote == null) return

                // 3. Set the status text and powered by
                const statusText = getRateFromQuote(bestQuote, displayFiatCurrencyCode)
                enterAmountMethods.setStatusText({ statusText })
                enterAmountMethods.setPoweredBy({ poweredByText: bestQuote.pluginDisplayName, poweredByIcon: bestQuote.partnerIcon, poweredByOnClick })

                logEvent(isBuy ? 'Buy_Quote_Change_Provider' : 'Sell_Quote_Change_Provider')

                if (sourceFieldNum === 1) {
                  enterAmountMethods.setValue2(bestQuote.cryptoAmount)
                } else {
                  enterAmountMethods.setValue1(bestQuote.fiatAmount)
                }
              }
            }

            enterAmountMethods.setStatusText({ statusText: exchangeRateText })
            enterAmountMethods.setPoweredBy({ poweredByText: bestQuote.pluginDisplayName, poweredByIcon: bestQuote.partnerIcon, poweredByOnClick })
          }
          if (sourceFieldNum === 1) {
            return toFixed(bestQuote.cryptoAmount, 0, 6)
          } else {
            return toFixed(bestQuote.fiatAmount, 0, 2)
          }
        },
        async onSubmit() {
          if (bestQuote == null) {
            return
          }
          await bestQuote.approveQuote({ showUi, coreWallet })
        }
      })
    }
  }
  return fiatPlugin
}

// Returns an array with a sort index according to the desired priority in
// showing the quotes.
// TODO: conflict: also defines whether or not to accept a quote from the
// provider
export const createPriorityArray = (providerPriority: ProviderPriorityMap): PriorityArray => {
  const priorityArray: PriorityArray = []
  if (providerPriority != null) {
    const temp: Array<{ pluginId: string; priority: number }> = []
    for (const pluginId in providerPriority) {
      temp.push({ pluginId, priority: providerPriority[pluginId] })
    }
    temp.sort((a, b) => b.priority - a.priority)
    let currentPriority = Infinity
    let priorityObj: PriorityArray[number] = {}
    for (const t of temp) {
      if (t.priority < currentPriority) {
        priorityArray.push({})
        currentPriority = t.priority
        priorityObj = priorityArray[priorityArray.length - 1]
      }
      priorityObj[t.pluginId] = true
    }
  }
  return priorityArray
}

export const getBestQuote = (quotes: FiatProviderQuote[], priorityArray: PriorityArray): FiatProviderQuote | undefined => {
  let bestQuote
  let bestQuoteRatio = '0'
  for (const p of priorityArray) {
    for (const quote of quotes) {
      if (!p[quote.pluginId]) continue
      const quoteRatio = div(quote.cryptoAmount, quote.fiatAmount, 16)

      if (gt(quoteRatio, bestQuoteRatio)) {
        bestQuoteRatio = quoteRatio
        bestQuote = quote
      }
    }
    if (bestQuote != null) return bestQuote
  }
}
