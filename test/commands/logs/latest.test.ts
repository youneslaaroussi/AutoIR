import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('logs latest', () => {
  it('prints dry-run for group with implicit stream', async () => {
    const {stdout} = await runCommand('logs latest /aws/lambda/demo --dry-run')
    expect(stdout).to.contain('[dry-run] aws logs describe-log-streams')
  })

  it('prints dry-run for events when stream provided', async () => {
    const {stdout} = await runCommand('logs latest /aws/lambda/demo --stream s1 --dry-run')
    expect(stdout).to.contain('[dry-run] aws logs get-log-events')
  })
})


