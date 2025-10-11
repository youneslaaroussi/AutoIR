import {Command} from '@oclif/core'
import chalk from 'chalk'

export default class AwsKimiK2Manage extends Command {
  static description = 'Deprecated: Use Amazon Bedrock instead of Kimi K2'

  static examples = [
    '<%= config.bin %> <%= command.id %> --action start --endpoint kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --action stop --endpoint kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --action status --endpoint kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --action terminate --endpoint kimi-k2-dev --confirm',
  ]

  static flags = {}

  async run(): Promise<void> {
    this.log(chalk.yellow('Kimi K2 management is no longer supported.'))
    this.log(chalk.green('Use Amazon Bedrock instead:'))
    this.log('  autoir llm config --provider bedrock --endpoint us.amazon.nova-micro-v1:0')
  }
    this.log(chalk.yellow('Kimi K2 management is no longer supported.'))
    this.log(chalk.green('Use Amazon Bedrock instead:'))
    this.log('  autoir llm config --provider bedrock --endpoint us.amazon.nova-micro-v1:0')
  }
}
