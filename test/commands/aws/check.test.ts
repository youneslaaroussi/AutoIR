import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('aws check', () => {
  it('supports dry-run', async () => {
    const {stdout} = await runCommand('aws check --dry-run')
    expect(stdout).to.contain('[dry-run] aws --version')
    expect(stdout).to.contain('[dry-run] aws sts get-caller-identity')
  })
})


