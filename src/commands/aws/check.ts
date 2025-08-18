import {Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

export default class AwsCheck extends Command {
  static args = {}

  static description = 'Check for AWS CLI existence and verify authentication (STS caller identity)'

  static examples = [
    '<%= config.bin %> <%= command.id %> --profile default',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ]

  static flags = {
    profile: Flags.string({
      char: 'p',
      description: 'AWS profile to use',
    }),
    json: Flags.boolean({
      description: 'Output JSON',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Print the commands that would be executed without running them',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AwsCheck)
    const profileArgs = flags.profile ? ['--profile', flags.profile] as const : ([] as const)

    const versionCmd = ['--version'] as const
    const identityCmd = ['sts', 'get-caller-identity', '--output', 'json', ...profileArgs]

    if (flags['dry-run']) {
      this.log('[dry-run] aws ' + versionCmd.join(' '))
      this.log('[dry-run] aws ' + identityCmd.join(' '))
      return
    }

    // 1) Check CLI presence
    try {
      const {stdout, stderr} = await execFileAsync('aws', [...versionCmd])
      const output = (stdout || stderr || '').trim()
      this.log(output)
    } catch (error: any) {
      this.error('AWS CLI not found or not executable. Please install AWS CLI v2 and ensure it is on your PATH.')
      return
    }

    // 2) Check authentication via STS
    try {
      const {stdout} = await execFileAsync('aws', [...identityCmd])
      if (flags.json) {
        this.log(stdout.trim())
        return
      }

      const data = JSON.parse(stdout)
      this.log(`Authenticated as: ${data.Arn}`)
      if (data.Account) this.log(`Account: ${data.Account}`)
      if (data.UserId) this.log(`UserId: ${data.UserId}`)
    } catch (error: any) {
      const message = error?.stderr?.toString?.() || error?.message || String(error)
      this.error(`Failed to verify AWS authentication. ${message}`)
    }
  }
}


