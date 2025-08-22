import {Command, Flags} from '@oclif/core'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import inquirer from 'inquirer'
import chalk from 'chalk'
import ora from 'ora'

interface SlackConfig {
  botToken: string
  appToken: string
  signingSecret: string
  channels: string[]
  webhookUrl?: string
}

const SLACK_CONFIG_DIR = path.join(os.homedir(), '.autoir')
const SLACK_CONFIG_FILE = path.join(SLACK_CONFIG_DIR, 'slack-config.json')

export default class SlackSetup extends Command {
  static description = 'Interactive setup for Slack bot integration with real credentials'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
  ]

  static flags = {
    'skip-test': Flags.boolean({description: 'Skip testing the Slack connection', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SlackSetup)

    this.log(chalk.blue.bold('🤖 AutoIR Slack Bot Setup'))
    this.log()
    this.log('This will configure a real Slack bot that can join channels and send incident reports.')
    this.log()
    this.log(chalk.yellow('Prerequisites:'))
    this.log('1. Create a Slack app at https://api.slack.com/apps')
    this.log('2. Add Bot Token Scopes: chat:write, channels:join, channels:read')
    this.log('3. Install the app to your workspace')
    this.log('4. Get your Bot User OAuth Token (starts with xoxb-)')
    this.log()

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'botToken',
        message: 'Enter your Slack Bot User OAuth Token (xoxb-...):',
        validate: (input: string) => {
          if (!input.startsWith('xoxb-')) {
            return 'Bot token should start with "xoxb-"'
          }
          return true
        },
      },
      {
        type: 'input',
        name: 'appToken',
        message: 'Enter your Slack App-Level Token (xapp-...) [Optional]:',
        default: '',
      },
      {
        type: 'input',
        name: 'signingSecret',
        message: 'Enter your Slack Signing Secret [Optional]:',
        default: '',
      },
      {
        type: 'input',
        name: 'webhookUrl',
        message: 'Enter your Slack Webhook URL (for simple notifications) [Optional]:',
        default: '',
      },
      {
        type: 'input',
        name: 'channels',
        message: 'Enter channel names to join (comma-separated, e.g., general,alerts):',
        default: 'general',
        filter: (input: string) => input.split(',').map(c => c.trim()).filter(c => c.length > 0),
      },
    ])

    const config: SlackConfig = {
      botToken: answers.botToken,
      appToken: answers.appToken || '',
      signingSecret: answers.signingSecret || '',
      channels: answers.channels,
      webhookUrl: answers.webhookUrl || undefined,
    }

    if (!flags['skip-test']) {
      await this.testSlackConnection(config)
    }

    await this.saveConfig(config)
    
    this.log()
    this.log(chalk.green.bold('✅ Slack bot configured successfully!'))
    this.log()
    this.log('The bot will now:')
    this.log(`• Join channels: ${config.channels.join(', ')}`)
    this.log('• Send incident reports automatically')
    this.log('• Provide real-time alerts during demos')
    this.log()
    this.log(chalk.cyan('Test the integration with:'))
    this.log(`  ${chalk.bold('autoir slack test')}`)
  }

  private async testSlackConnection(config: SlackConfig): Promise<void> {
    const spinner = ora('Testing Slack connection...').start()

    try {
      // Test bot token validity
      const response = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.botToken}`,
          'Content-Type': 'application/json',
        },
      })

      const data = await response.json() as any
      
      if (!data.ok) {
        throw new Error(`Slack API error: ${data.error}`)
      }

      spinner.succeed(`Connected as ${data.user} in ${data.team}`)

      // Try to join channels
      for (const channel of config.channels) {
        const joinSpinner = ora(`Joining channel #${channel}...`).start()
        
        try {
          const joinResponse = await fetch('https://slack.com/api/conversations.join', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: channel,
            }),
          })

          const joinData = await joinResponse.json() as any
          
          if (joinData.ok) {
            joinSpinner.succeed(`Joined #${channel}`)
          } else if (joinData.error === 'already_in_channel') {
            joinSpinner.succeed(`Already in #${channel}`)
          } else {
            joinSpinner.warn(`Could not join #${channel}: ${joinData.error}`)
          }
        } catch (error) {
          joinSpinner.warn(`Could not join #${channel}: ${error}`)
        }
      }

      // Send a test message
      const testSpinner = ora('Sending test message...').start()
      
      const testChannel = config.channels[0]
      const testResponse = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: testChannel,
          text: '🤖 AutoIR Bot is now connected and ready for incident reporting!',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*🤖 AutoIR Bot Setup Complete*\n\nI\'m now connected and ready to send incident reports and alerts during your demo!'
              }
            }
          ]
        }),
      })

      const testData = await testResponse.json() as any
      
      if (testData.ok) {
        testSpinner.succeed(`Test message sent to #${testChannel}`)
      } else {
        testSpinner.warn(`Could not send test message: ${testData.error}`)
      }

    } catch (error) {
      spinner.fail(`Connection failed: ${error}`)
      throw error
    }
  }

  private async saveConfig(config: SlackConfig): Promise<void> {
    await fs.mkdir(SLACK_CONFIG_DIR, {recursive: true})
    await fs.writeFile(SLACK_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  }
}