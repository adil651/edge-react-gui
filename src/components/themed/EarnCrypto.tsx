import { EdgeCurrencyWallet } from 'edge-core-js'
import * as React from 'react'
import { View } from 'react-native'
import FastImage from 'react-native-fast-image'
import { sprintf } from 'sprintf-js'

import { guiPlugins } from '../../constants/plugins/GuiPlugins'
import { SPECIAL_CURRENCY_INFO } from '../../constants/WalletAndCurrencyConstants'
import { useHandler } from '../../hooks/useHandler'
import s from '../../locales/strings'
import { getDefaultFiat } from '../../selectors/SettingsSelectors'
import { useSelector } from '../../types/reactRedux'
import { Actions } from '../../types/routerTypes'
import { getCurrencyIconUris } from '../../util/CdnUris'
import { getCurrencyCode } from '../../util/CurrencyInfoHelpers'
import { cacheStyles, Theme, useTheme } from '../services/ThemeContext'
import { EdgeText } from '../themed/EdgeText'
import { ButtonBox } from '../themed/ThemedButtons'

export const ioniaPluginIds = Object.keys(SPECIAL_CURRENCY_INFO).filter(pluginId => !!SPECIAL_CURRENCY_INFO[pluginId].displayIoniaRewards)

interface Props {
  wallet: EdgeCurrencyWallet
  tokenId?: string
}

export const EarnCrypto = (props: Props) => {
  const { wallet, tokenId } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const defaultFiat = useSelector(state => getDefaultFiat(state))

  const handlePress = useHandler(() => {
    Actions.push('pluginView', {
      plugin: guiPlugins.ionia
    })
  })

  const { pluginId } = wallet.currencyInfo
  const icon = getCurrencyIconUris(pluginId, tokenId)
  const currencyCode = getCurrencyCode(wallet, tokenId)

  return (
    <>
      {ioniaPluginIds.includes(pluginId) && tokenId == null && (
        <ButtonBox marginRem={[1, 0, -1, 0]} onPress={handlePress}>
          <View style={styles.container}>
            <FastImage resizeMode="contain" source={{ uri: icon.symbolImage }} style={styles.icon} />
            <EdgeText numberOfLines={0} style={styles.text}>
              {sprintf(s.strings.side_menu_rewards_tx_list_button_2s, defaultFiat, currencyCode)}
            </EdgeText>
          </View>
        </ButtonBox>
      )}
    </>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: theme.rem(0.5),
    backgroundColor: theme.tileBackground,
    borderWidth: theme.cardBorder,
    borderColor: theme.cardBorderColor
  },
  icon: {
    width: theme.rem(2),
    height: theme.rem(2),
    margin: theme.rem(0.5)
  },
  text: {
    flex: 1,
    margin: theme.rem(0.5)
  }
}))
