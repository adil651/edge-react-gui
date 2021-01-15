// @flow

import { type EdgeAccount, type EdgeContext } from 'edge-core-js'
import { ChangePasswordScreen } from 'edge-login-ui-rn'
import * as React from 'react'
import { ScrollView, View } from 'react-native'
import { Actions } from 'react-native-router-flux'
import { connect } from 'react-redux'

import { THEME } from '../../theme/variables/airbitz'
import { type RootState } from '../../types/reduxTypes.js'
import { SceneWrapper } from '../common/SceneWrapper.js'

type StateProps = {
  account: EdgeAccount,
  context: EdgeContext
}
type DispatchProps = {
  onComplete: () => void
}
type Props = StateProps & DispatchProps

class ChangePasswordComponent extends React.Component<Props> {
  render() {
    const { context, account, onComplete } = this.props

    return (
      <SceneWrapper hasTabs={false} background="body">
        <ScrollView keyboardShouldPersistTaps="always">
          <ChangePasswordScreen account={account} context={context} onComplete={onComplete} onCancel={onComplete} showHeader={false} />
          <View style={{ backgroundColor: THEME.COLORS.WHITE, height: 360 }} />
        </ScrollView>
      </SceneWrapper>
    )
  }
}

export const ChangePasswordScene = connect(
  (state: RootState): StateProps => ({
    context: state.core.context,
    account: state.core.account
  }),
  (dispatch: Dispatch): DispatchProps => ({
    onComplete: Actions.pop
  })
)(ChangePasswordComponent)
