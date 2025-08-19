import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import inquirer from 'inquirer'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import {getLlmConfig, setLlmConfig} from '../../lib/config.js'

export default class LlmConfig extends Command {
  static description = 'Configure LLM provider (AWS Kimi K2 or OpenAI) and credentials'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --provider openai',
  ]

  static flags = {
    provider: Flags.string({options: ['aws', 'openai'] as const, description: 'LLM provider to use'}),
    'openai-key': Flags.string({description: 'OpenAI API key'}),
    'openai-model': Flags.string({description: 'OpenAI model', default: 'gpt-4o-mini'}),
    endpoint: Flags.string({description: 'Default AWS/Kimi K2 endpoint name to use'}),
  }

  private endpointsPath = path.join(os.homedir(), '.autoir', 'kimi-k2-endpoints.json')

  async run(): Promise<void> {
    const {flags} = await this.parse(LlmConfig)

    const current = await getLlmConfig()

    let provider = flags.provider as 'aws' | 'openai' | undefined
    let openaiKey = flags['openai-key']
    let openaiModel = flags['openai-model']
    let endpoint = flags.endpoint

    if (!provider) {
      const answer = await inquirer.prompt([{
        type: 'list',
        name: 'provider',
        message: 'Choose LLM provider',
        default: current?.provider || 'aws',
        choices: [
          {name: 'AWS self-hosted (Kimi K2)', value: 'aws'},
          {name: 'OpenAI', value: 'openai'}
        ]
      }])
      provider = answer.provider
    }

    if (provider === 'openai') {
      if (!openaiKey) {
        const answer = await inquirer.prompt([{
          type: 'password',
          name: 'openaiKey',
          message: 'Enter OpenAI API key',
          mask: '*',
          default: current?.openaiApiKey ? '********' : undefined
        }])
        openaiKey = answer.openaiKey === '********' ? current?.openaiApiKey : answer.openaiKey
      }
      if (!openaiModel) {
        const answer = await inquirer.prompt([{
          type: 'input',
          name: 'openaiModel',
          message: 'OpenAI model',
          default: current?.openaiModel || 'gpt-4o-mini'
        }])
        openaiModel = answer.openaiModel
      }
      await setLlmConfig({provider: 'openai', openaiApiKey: openaiKey!, openaiModel})
      this.log(chalk.green('LLM provider set to OpenAI.'))
    } else {
      // AWS path: optionally pick default endpoint
      if (!endpoint) {
        const endpoints = await this.loadAwsEndpoints()
        const names = Object.keys(endpoints)
        if (names.length > 0) {
          const answer = await inquirer.prompt([{
            type: 'list',
            name: 'endpoint',
            message: 'Select default AWS/Kimi K2 endpoint (optional)',
            choices: [...names, new inquirer.Separator(), 'Skip'],
            default: current?.currentEndpoint && names.includes(current.currentEndpoint) ? current.currentEndpoint : undefined
          }])
          endpoint = answer.endpoint === 'Skip' ? undefined : answer.endpoint
        }
      }
      await setLlmConfig({provider: 'aws', currentEndpoint: endpoint})
      this.log(chalk.green(`LLM provider set to AWS${endpoint ? ` (default endpoint: ${endpoint})` : ''}.`))
    }
  }

  private async loadAwsEndpoints(): Promise<Record<string, {endpoint: string}>> {
    try {
      const raw = await fs.readFile(this.endpointsPath, 'utf8')
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
}
