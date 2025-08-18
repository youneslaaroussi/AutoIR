import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('tidb oauth', () => {
  it('supports dry-run', async () => {
    const {stdout} = await runCommand('tidb oauth --dry-run')
    expect(stdout).to.satisfy((out: string) => out.includes('[dry-run] ticloud auth login') || out.includes('[dry-run] open https://tidbcloud.com/console/login'))
  })
})


