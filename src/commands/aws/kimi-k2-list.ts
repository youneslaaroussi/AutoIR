import {Command} from '@oclif/core'
import chalk from 'chalk'

export default class AwsKimiK2List extends Command {
  static description = 'Deprecated: Use Amazon Bedrock instead of Kimi K2'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --test',
    '<%= config.bin %> <%= command.id %> --test --endpoint kimi-k2-dev',
  ]

  static flags = {}

  async run(): Promise<void> {
    this.log(chalk.yellow('Kimi K2 endpoints are no longer used.'))
    this.log(chalk.green('Use Amazon Bedrock instead:'))
    this.log('  autoir llm config --provider bedrock --endpoint us.amazon.nova-micro-v1:0')
  }
}
