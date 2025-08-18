import {Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import chalk from 'chalk'
import ora from 'ora'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)

export default class AwsKimiK2List extends Command {
  static description = 'List and test saved Kimi K2 endpoints'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --test',
    '<%= config.bin %> <%= command.id %> --test --endpoint kimi-k2-dev',
  ]

  static flags = {
    test: Flags.boolean({description: 'Test endpoint connectivity and model response', default: false}),
    endpoint: Flags.string({description: 'Specific endpoint name to test (if not provided, tests all)'}),
    json: Flags.boolean({description: 'Output in JSON format', default: false}),
    prompt: Flags.string({description: 'Custom prompt for testing', default: 'Hello! How are you?'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AwsKimiK2List)
    
    const configPath = path.join(os.homedir(), '.autoir', 'kimi-k2-endpoints.json')
    
    let config: any = {}
    try {
      const configData = await fs.readFile(configPath, 'utf-8')
      config = JSON.parse(configData)
    } catch (e) {
      this.log(chalk.yellow('No saved Kimi K2 endpoints found.'))
      this.log('Use `autoir aws kimi-k2-setup` to create one.')
      return
    }

    const endpoints = Object.keys(config)
    if (endpoints.length === 0) {
      this.log(chalk.yellow('No Kimi K2 endpoints configured.'))
      return
    }

    if (flags.json && !flags.test) {
      this.log(JSON.stringify(config, null, 2))
      return
    }

    if (!flags.test) {
      this.log(chalk.blue('Saved Kimi K2 Endpoints:'))
      this.log('')
      
      for (const [name, info] of Object.entries(config)) {
        const endpoint = info as any
        this.log(chalk.green(`${name}:`))
        this.log(`  Endpoint: ${endpoint.endpoint}`)
        this.log(`  Public IP: ${endpoint.publicIp}`)
        this.log(`  Region: ${endpoint.region}`)
        this.log(`  Quantization: ${endpoint.quantization}`)
        this.log(`  Created: ${new Date(endpoint.createdAt).toLocaleString()}`)
        this.log('')
      }
      
      this.log(chalk.cyan('Use --test to check endpoint status'))
      return
    }

    // Test mode
    const endpointsToTest = flags.endpoint ? 
      (config[flags.endpoint] ? {[flags.endpoint]: config[flags.endpoint]} : {}) : 
      config

    if (Object.keys(endpointsToTest).length === 0) {
      this.error(`Endpoint '${flags.endpoint}' not found`)
    }

    const results: any = {}

    for (const [name, info] of Object.entries(endpointsToTest)) {
      const endpoint = info as any
      this.log(chalk.blue(`Testing ${name}...`))
      
      const result = await this.testEndpoint(endpoint.endpoint, flags.prompt)
      results[name] = result
      
      if (result.success) {
        this.log(chalk.green(`${name}: Online and responding`))
        if (result.response) {
          this.log(chalk.gray(`   Response preview: ${result.response.slice(0, 100)}...`))
        }
        if (result.responseTime) {
          this.log(chalk.gray(`   Response time: ${result.responseTime}ms`))
        }
      } else {
        this.log(chalk.red(`${name}: ${result.error}`))
      }
      this.log('')
    }

    if (flags.json) {
      this.log(JSON.stringify(results, null, 2))
    }
  }

  private async testEndpoint(endpoint: string, prompt: string): Promise<{
    success: boolean,
    error?: string,
    response?: string,
    responseTime?: number
  }> {
    const sp = ora(`Testing ${endpoint}`).start()
    
    try {
      const startTime = Date.now()
      
      // First, try a simple health check
      try {
        await execFileAsync('curl', [
          '-s', '-f', '--connect-timeout', '5', '--max-time', '10',
          `${endpoint}/health`
        ])
      } catch (e) {
        // Health endpoint might not exist, try the main completion endpoint
      }

      // Test with actual completion request
      const testPayload = JSON.stringify({
        prompt: `<|im_system|>system<|im_middle|>You are a helpful assistant. Respond briefly.<|im_end|><|im_user|>user<|im_middle|>${prompt}<|im_end|><|im_assistant|>assistant<|im_middle|>`,
        temperature: 0.6,
        min_p: 0.01,
        n_predict: 50
      })
      
      const {stdout} = await execFileAsync('curl', [
        '-s', '-f', '--connect-timeout', '10', '--max-time', '60',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', testPayload,
        `${endpoint}/completion`
      ])
      
      const responseTime = Date.now() - startTime
      sp.stop()
      
      // Try to parse response and extract content
      let responseText = stdout
      try {
        const jsonResponse = JSON.parse(stdout)
        if (jsonResponse.content) {
          responseText = jsonResponse.content
        } else if (jsonResponse.choices && jsonResponse.choices[0]?.text) {
          responseText = jsonResponse.choices[0].text
        }
      } catch (e) {
        // Response might not be JSON, use as-is
      }
      
      return {
        success: true,
        response: responseText,
        responseTime
      }
      
    } catch (error: any) {
      sp.stop()
      
      let errorMsg = 'Connection failed'
      const stderr = error?.stderr?.toString?.() || error?.message || String(error)
      
      if (stderr.includes('Connection refused')) {
        errorMsg = 'Service not running'
      } else if (stderr.includes('timeout') || stderr.includes('timed out')) {
        errorMsg = 'Request timeout'
      } else if (stderr.includes('404')) {
        errorMsg = 'Endpoint not found'
      } else if (stderr.includes('500')) {
        errorMsg = 'Server error'
      } else if (stderr.includes('Could not resolve host')) {
        errorMsg = 'Host unreachable'
      }
      
      return {
        success: false,
        error: errorMsg
      }
    }
  }
}
