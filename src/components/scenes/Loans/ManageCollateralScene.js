// @flow

import { mul } from 'biggystring'
import type { EdgeCurrencyWallet } from 'edge-core-js'
import * as React from 'react'
import { sprintf } from 'sprintf-js'

import { getSpecialCurrencyInfo } from '../../../constants/WalletAndCurrencyConstants.js'
import { makeActionProgram } from '../../../controllers/action-queue/ActionProgram'
import { useRunningActionQueueId } from '../../../controllers/action-queue/ActionQueueStore'
import { runLoanActionProgram } from '../../../controllers/loan-manager/redux/actions'
import { type LoanAccount } from '../../../controllers/loan-manager/types'
import { useAsyncEffect } from '../../../hooks/useAsyncEffect.js'
import { useHandler } from '../../../hooks/useHandler.js'
import { useWatch } from '../../../hooks/useWatch.js'
import s from '../../../locales/strings.js'
import type { ApprovableAction } from '../../../plugins/borrow-plugins/types.js'
import { useRef, useState } from '../../../types/reactHooks.js'
import { useDispatch, useSelector } from '../../../types/reactRedux.js'
import { type NavigationProp, type ParamList } from '../../../types/routerTypes'
import { zeroString } from '../../../util/utils.js'
import { FlipInputTile } from '../../cards/FlipInputTile.js'
import { CollateralAmountTile, DebtAmountTile, NetworkFeeTile } from '../../LoanComponents.js'
import { type WalletListResult, WalletListModal } from '../../modals/WalletListModal.js'
import { Airship, showError } from '../../services/AirshipInstance'
import { type ExchangedFlipInputAmounts } from '../../themed/ExchangedFlipInput.js'
import { AprCard } from '../../tiles/AprCard.js'
import { InterestRateChangeTile } from '../../tiles/InterestRateChangeTile.js'
import { LoanToValueTile } from '../../tiles/LoanToValueTile.js'
import { FormScene } from '../FormScene.js'

// TODO: Integrate future changes to incorporate token contract addresses into the borrow plugin's domain
const collateralTokenMap = {
  ethereum: [{ pluginId: 'ethereum', tokenId: '2260fac5e5542a773aa44fbcfedf7c193bc2c599', currencyCode: 'WBTC' }],
  kovan: [{ pluginId: 'kovan', tokenId: 'd1b98b6607330172f1d991521145a22bce793277', currencyCode: 'WBTC' }],
  polygon: [{ pluginId: 'polygon', tokenId: '1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', currencyCode: 'WBTC' }]
}

type ManageCollateralRequest = {
  tokenId?: string,
  ['fromWallet' | 'toWallet']: EdgeCurrencyWallet,
  nativeAmount: string
}

type Props<T: $Keys<ParamList>> = {
  // TODO: Remove use of ApprovableAction to calculate fees. Update ActionQueue to handle fee calcs
  action: (request: ManageCollateralRequest) => Promise<ApprovableAction>,
  actionOperand: 'debts' | 'collaterals',
  actionOpType: 'loan-borrow' | 'loan-deposit' | 'loan-repay' | 'loan-withdraw',
  actionWallet: 'fromWallet' | 'toWallet',
  amountChange?: 'increase' | 'decrease',
  loanAccount: LoanAccount,

  showNewDebtAprChange?: true,
  showNewDebtTile?: boolean,
  showTotalCollateralTile?: boolean,
  showTotalDebtTile?: boolean,

  headerText: string,
  navigation: NavigationProp<T>
}

export const ManageCollateralScene = <T: $Keys<ParamList>>(props: Props<T>) => {
  const {
    action,
    actionOperand,
    actionOpType,
    actionWallet,
    amountChange = 'increase',
    loanAccount,

    showNewDebtAprChange,
    showNewDebtTile,
    showTotalCollateralTile,
    showTotalDebtTile,

    headerText,
    navigation
  } = props

  const { borrowEngine, borrowPlugin } = loanAccount
  const { currencyWallet: borrowEngineWallet } = loanAccount.borrowEngine
  const {
    currencyConfig: { allTokens },
    currencyInfo: borrowEngineCurrencyInfo,
    id: borrowEngineWalletId
  } = borrowEngineWallet
  const { pluginId: borrowEnginePluginId } = borrowEngineCurrencyInfo

  const collaterals = useWatch(borrowEngine, 'collaterals')
  const debts = useWatch(borrowEngine, 'debts')

  // State
  const account = useSelector(state => state.core.account)
  const dispatch = useDispatch()
  const wallets = useWatch(account, 'currencyWallets')

  // Skip directly to LoanStatusScene if an action for the same actionOpType is already being processed
  const existingProgramId = useRunningActionQueueId(actionOpType, borrowEngineWalletId)
  if (existingProgramId != null) navigation.navigate('loanDetailsStatus', { actionQueueId: existingProgramId })

  // Flip input selected wallet
  const [selectedWallet, setSelectedWallet] = useState<EdgeCurrencyWallet>(borrowEngineWallet)
  const defaultTokenId = actionOperand === 'collaterals' ? collaterals[0].tokenId : debts[0].tokenId
  const [selectedTokenId, setSelectedTokenId] = useState<string | void>(defaultTokenId)
  const selectedWalletName = useWatch(selectedWallet, 'name') ?? ''
  const { currencyCode: selectedCurrencyCode } = selectedTokenId == null ? borrowEngineCurrencyInfo : allTokens[selectedTokenId]
  const hasMaxSpend = getSpecialCurrencyInfo(borrowEnginePluginId).noMaxSpend !== true

  // Borrow engine stuff
  const [approvalAction, setApprovalAction] = useState<ApprovableAction | null>(null)
  const [actionNativeAmount, setActionNativeAmount] = useState('0')
  const [newDebtApr, setNewDebtApr] = useState(0)
  const collateralTokens = collateralTokenMap[borrowEnginePluginId]

  const [actionOp, setactionOp] = useState()
  useAsyncEffect(async () => {
    const actionOp = {
      type: 'seq',
      actions: [
        // TODO: Update typing so Flow doesn't complain
        // $FlowFixMe
        {
          type: actionOpType,
          borrowPluginId: borrowPlugin.borrowInfo.borrowPluginId,
          nativeAmount: actionNativeAmount,
          walletId: selectedWallet.id,
          tokenId: selectedTokenId
        }
      ]
    }
    setactionOp(actionOp)
  }, [actionNativeAmount, selectedWallet, selectedTokenId])

  useAsyncEffect(async () => {
    if (zeroString(actionNativeAmount)) {
      setApprovalAction(null)
      return
    }

    const request = {
      nativeAmount: actionNativeAmount,
      [actionWallet]: selectedWallet,
      tokenId: selectedTokenId
    }

    const approvalAction = await action(request)
    setApprovalAction(approvalAction)

    if (showNewDebtAprChange) {
      const apr = await borrowEngine.getAprQuote(selectedTokenId)
      setNewDebtApr(apr)
    }
  }, [actionNativeAmount])

  // Max send utils
  const toggleMaxSpend = useRef(false)

  const onMaxSpend = useHandler(() => {
    toggleMaxSpend.current = !toggleMaxSpend.current
  })

  const [firstLaunch, setFirstLaunch] = useState(true)
  useAsyncEffect(async () => {
    if (firstLaunch) {
      // Don't call getMaxSpendable when the component is mounted
      setFirstLaunch(false)
      return
    }
    const spendAddress = collateralTokens.find(collateralToken => collateralToken.currencyCode === selectedCurrencyCode)
    const spendInfo = {
      currencyCode: selectedCurrencyCode,
      spendTargets: [
        {
          publicAddress: `0x${spendAddress?.tokenId}` // TODO: replace with aave contract? Just needed a contract address here
        }
      ]
    }
    const nativeAmount = await selectedWallet.getMaxSpendable(spendInfo)
    setActionNativeAmount(nativeAmount)
  }, [toggleMaxSpend.current])

  const handleAmountChanged = useHandler((amounts: ExchangedFlipInputAmounts) => {
    setActionNativeAmount(amounts.nativeAmount)
  })

  const showWalletPicker = useHandler(() => {
    const allowedAssets = collateralTokens
    Airship.show(bridge => (
      <WalletListModal bridge={bridge} headerTitle={s.strings.select_src_wallet} showCreateWallet={false} allowedAssets={allowedAssets} />
    )).then(({ walletId, currencyCode, tokenId }: WalletListResult) => {
      if (walletId != null && currencyCode != null) {
        setSelectedWallet(wallets[walletId])
        setSelectedTokenId(tokenId)
        setActionNativeAmount('0')
      }
    })
  })

  const onSliderComplete = async (resetSlider: () => void) => {
    if (actionOp != null) {
      const actionProgram = await makeActionProgram(actionOp)
      try {
        await dispatch(runLoanActionProgram(loanAccount, actionProgram, actionOpType))
        navigation.navigate('loanDetailsStatus', { actionQueueId: actionProgram.programId })
      } catch (e) {
        showError(e)
      } finally {
        resetSlider()
      }
    }
  }

  // Tile Data
  const actionAmountChange = amountChange === 'increase' ? '1' : '-1'
  const newLoanAmount = { nativeAmount: mul(actionNativeAmount, actionAmountChange), tokenId: selectedTokenId, apr: 0 } // APR is only present to appease Flow. It does not mean anything.

  const feeNativeAmount = approvalAction != null ? approvalAction.networkFee.nativeAmount : '0'

  const newDebt = { nativeAmount: actionNativeAmount, tokenId: selectedTokenId, apr: newDebtApr }

  return (
    <FormScene headerText={headerText} onSliderComplete={onSliderComplete} sliderDisabled={approvalAction == null}>
      <FlipInputTile
        hasMaxSpend={hasMaxSpend}
        onMaxSpend={onMaxSpend}
        headerText={sprintf(s.strings.loan_add_from, selectedWalletName)}
        launchWalletSelector={showWalletPicker}
        onCryptoExchangeAmountChanged={handleAmountChanged}
        wallet={selectedWallet}
        tokenId={selectedTokenId}
        key="flipInput"
      />
      {showNewDebtAprChange ? <AprCard apr={newDebtApr} key="apr" /> : null}
      {showTotalDebtTile ? <DebtAmountTile title={s.strings.loan_current_principle} wallet={borrowEngineWallet} debts={debts} key="totalDebt" /> : null}
      {showNewDebtTile ? (
        <DebtAmountTile title={s.strings.loan_new_principle} wallet={borrowEngineWallet} debts={[...debts, newLoanAmount]} key="newDebt" />
      ) : null}
      {showTotalCollateralTile ? (
        <CollateralAmountTile title={s.strings.loan_total_collateral_value} wallet={borrowEngineWallet} collaterals={collaterals} key="totalcollateral" />
      ) : null}
      <NetworkFeeTile wallet={borrowEngineWallet} nativeAmount={feeNativeAmount} key="fee" />
      {showNewDebtAprChange != null ? <InterestRateChangeTile borrowEngine={borrowEngine} newDebt={newDebt} key="interestRate" /> : null}
      <LoanToValueTile
        borrowEngine={borrowEngine}
        tokenId={selectedTokenId}
        nativeAmount={actionNativeAmount}
        type={actionOperand}
        direction={amountChange}
        key="ltv"
      />
    </FormScene>
  )
}
