import {Command, Flags} from '@oclif/core'
import inquirer from 'inquirer'
import ora from 'ora'
import chalk from 'chalk'
import {lookupChannelId, saveSlackBotConfig, sendSlackBotMessage, validateSlackBot} from '../../lib/slack.js'
import {getSlackConfig, setSlackConfig} from '../../lib/config.js'

export default class SlackSetup extends Command {
	static description = 'Interactive setup for Slack bot credentials and test message'

	static flags = {
		botToken: Flags.string({description: 'Slack bot token (xoxb-...)'}),
		channel: Flags.string({description: 'Slack channel name or ID (e.g., #incidents or C123...)'}),
	}

	async run(): Promise<void> {
		const {flags} = await this.parse(SlackSetup)

		const existing = await getSlackConfig()
		const answers = await inquirer.prompt([
			{
				type: 'password',
				name: 'botToken',
				message: 'Enter your Slack bot token (xoxb-...)',
				mask: '*',
				default: flags.botToken || existing?.botToken || '',
				validate: (v: string) => /^xoxb-/.test(v) || 'Must start with xoxb-'
			},
			{
				type: 'input',
				name: 'channel',
				message: 'Enter channel name or ID to send reports (e.g., incidents or C123...)',
				default: flags.channel || existing?.channelName || existing?.channelId || '',
				validate: (v: string) => !!v || 'Channel is required'
			},
		])

		const spinner = ora('Validating Slack bot token...').start()
		try {
			const auth = await validateSlackBot(answers.botToken)
			if (!auth.ok) throw new Error('Invalid bot token')
			spinner.succeed(`Authenticated as ${auth.user} in ${auth.team}`)
		} catch (e: any) {
			spinner.fail(`Validation failed: ${e.message || String(e)}`)
			this.exit(1)
		}

		let channelId = answers.channel
		if (!/^C[A-Z0-9]/i.test(channelId)) {
			const spinner2 = ora('Resolving channel ID...').start()
			try {
				channelId = await lookupChannelId(answers.botToken, answers.channel.replace(/^#/, ''))
				spinner2.succeed(`Resolved channel ID: ${channelId}`)
			} catch (e: any) {
				spinner2.fail(`Failed to resolve channel: ${e.message || String(e)}`)
				this.exit(1)
			}
		}

		const testSpinner = ora('Sending test message to Slack...').start()
		try {
			const {ts} = await sendSlackBotMessage(answers.botToken, channelId, ':rocket: AutoIR connected! I will post incident reports here.')
			testSpinner.succeed('Test message sent')
			await setSlackConfig({ botToken: answers.botToken, channelId, channelName: answers.channel.replace(/^#/, ''), lastTestMessageTs: ts })
			this.log(chalk.green('Slack configuration saved.'))
		} catch (e: any) {
			testSpinner.fail(`Failed to send test message: ${e.message || String(e)}`)
			this.exit(1)
		}
	}
}