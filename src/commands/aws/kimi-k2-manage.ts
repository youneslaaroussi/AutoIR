import {Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import chalk from 'chalk'
import ora from 'ora'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)

export default class AwsKimiK2Manage extends Command {
  static description = 'Manage Kimi K2 EC2 instances (start, stop, terminate)'

  static examples = [
    '<%= config.bin %> <%= command.id %> --action start --endpoint kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --action stop --endpoint kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --action status --endpoint kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --action terminate --endpoint kimi-k2-dev --confirm',
  ]

  static flags = {
    action: Flags.string({
      description: 'Action to perform',
      required: true,
      options: ['start', 'stop', 'restart', 'terminate', 'status']
    }),
    endpoint: Flags.string({description: 'Endpoint name to manage', required: true}),
    region: Flags.string({char: 'r', description: 'AWS region (overrides saved config)'}),
    profile: Flags.string({char: 'p', description: 'AWS profile to use'}),
    confirm: Flags.boolean({description: 'Confirm destructive actions (required for terminate)', default: false}),
    'dry-run': Flags.boolean({description: 'Print commands without executing', default: false}),
    debug: Flags.boolean({description: 'Print AWS CLI stderr on failures', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AwsKimiK2Manage)
    
    // Load saved endpoint configuration
    const configPath = path.join(os.homedir(), '.autoir', 'kimi-k2-endpoints.json')
    let config: any = {}
    
    try {
      const configData = await fs.readFile(configPath, 'utf-8')
      config = JSON.parse(configData)
    } catch (e) {
      this.error('No saved Kimi K2 endpoints found. Use `autoir aws kimi-k2-setup` to create one.')
    }

    const endpointConfig = config[flags.endpoint]
    if (!endpointConfig) {
      this.error(`Endpoint '${flags.endpoint}' not found in configuration.`)
    }

    const region = flags.region || endpointConfig.region
    const base = ['--region', region]
    if (flags.profile) base.unshift('--profile', flags.profile)

    // Find the instance ID from the endpoint name
    const instanceId = await this.findInstanceId(flags.endpoint, base, flags.debug)
    if (!instanceId) {
      this.error(`Could not find EC2 instance for endpoint '${flags.endpoint}'`)
    }

    this.log(chalk.blue(`Managing Kimi K2 instance: ${flags.endpoint}`))
    this.log(`Instance ID: ${instanceId}`)
    this.log(`Region: ${region}`)
    this.log(`Action: ${flags.action}`)
    this.log('')

    switch (flags.action) {
      case 'start':
        await this.startInstance(instanceId, base, flags['dry-run'], flags.debug)
        break
      case 'stop':
        await this.stopInstance(instanceId, base, flags['dry-run'], flags.debug)
        break
      case 'restart':
        await this.restartInstance(instanceId, base, flags['dry-run'], flags.debug)
        break
      case 'terminate':
        if (!flags.confirm) {
          this.error('Terminate action requires --confirm flag to prevent accidental deletion')
        }
        await this.terminateInstance(instanceId, flags.endpoint, configPath, config, base, flags['dry-run'], flags.debug)
        break
      case 'status':
        await this.checkStatus(instanceId, endpointConfig, base, flags.debug)
        break
      default:
        this.error(`Unknown action: ${flags.action}`)
    }
  }

  private async findInstanceId(endpointName: string, base: string[], debug: boolean): Promise<string | null> {
    const sp = ora('Finding instance ID').start()
    
    try {
      const {stdout} = await execFileAsync('aws', [
        'ec2', 'describe-instances',
        '--filters',
        `Name=tag:Name,Values=${endpointName}`,
        'Name=tag:Purpose,Values=Kimi-K2-LLM',
        'Name=instance-state-name,Values=pending,running,stopping,stopped',
        '--query', 'Reservations[0].Instances[0].InstanceId',
        '--output', 'text',
        ...base
      ])
      
      const instanceId = stdout.trim()
      if (instanceId && instanceId !== 'None') {
        sp.succeed(`Found instance: ${instanceId}`)
        return instanceId
      }
      
      sp.fail('Instance not found')
      return null
    } catch (error: any) {
      sp.fail('Failed to find instance')
      if (debug) this.log(chalk.gray(error?.message || String(error)))
      return null
    }
  }

  private async startInstance(instanceId: string, base: string[], dryRun: boolean, debug: boolean) {
    const sp = ora('Starting instance').start()
    
    if (dryRun) {
      sp.succeed('[dry-run] Would start instance')
      return
    }

    try {
      await execFileAsync('aws', ['ec2', 'start-instances', '--instance-ids', instanceId, ...base])
      sp.succeed('Instance start requested')
      
      // Wait for instance to be running
      await this.waitForState(instanceId, 'running', base, debug)
      this.log(chalk.green('Instance is now running'))
      
      // Wait a bit for the service to start
      this.log('Waiting for Kimi K2 service to start...')
      await new Promise(r => setTimeout(r, 30000))
      
    } catch (error: any) {
      sp.fail('Failed to start instance')
      if (debug) this.log(chalk.gray(error?.message || String(error)))
      throw error
    }
  }

  private async stopInstance(instanceId: string, base: string[], dryRun: boolean, debug: boolean) {
    const sp = ora('Stopping instance').start()
    
    if (dryRun) {
      sp.succeed('[dry-run] Would stop instance')
      return
    }

    try {
      await execFileAsync('aws', ['ec2', 'stop-instances', '--instance-ids', instanceId, ...base])
      sp.succeed('Instance stop requested')
      
      // Wait for instance to be stopped
      await this.waitForState(instanceId, 'stopped', base, debug)
      this.log(chalk.green('Instance is now stopped'))
      
    } catch (error: any) {
      sp.fail('Failed to stop instance')
      if (debug) this.log(chalk.gray(error?.message || String(error)))
      throw error
    }
  }

  private async restartInstance(instanceId: string, base: string[], dryRun: boolean, debug: boolean) {
    this.log(chalk.blue('Restarting instance (stop + start)...'))
    await this.stopInstance(instanceId, base, dryRun, debug)
    await new Promise(r => setTimeout(r, 5000)) // Brief pause between stop and start
    await this.startInstance(instanceId, base, dryRun, debug)
  }

  private async terminateInstance(instanceId: string, endpointName: string, configPath: string, config: any, base: string[], dryRun: boolean, debug: boolean) {
    this.log(chalk.red('WARNING: This will permanently delete the instance and all data!'))
    
    const sp = ora('Terminating instance').start()
    
    if (dryRun) {
      sp.succeed('[dry-run] Would terminate instance and remove from config')
      return
    }

    try {
      await execFileAsync('aws', ['ec2', 'terminate-instances', '--instance-ids', instanceId, ...base])
      sp.succeed('Instance termination requested')
      
      // Remove from config
      delete config[endpointName]
      await fs.writeFile(configPath, JSON.stringify(config, null, 2))
      
      this.log(chalk.green('Instance terminated and removed from configuration'))
      
    } catch (error: any) {
      sp.fail('Failed to terminate instance')
      if (debug) this.log(chalk.gray(error?.message || String(error)))
      throw error
    }
  }

  private async checkStatus(instanceId: string, endpointConfig: any, base: string[], debug: boolean) {
    const sp = ora('Checking instance status').start()
    
    try {
      const {stdout} = await execFileAsync('aws', [
        'ec2', 'describe-instances',
        '--instance-ids', instanceId,
        '--query', 'Reservations[0].Instances[0].[State.Name,PublicIpAddress,PrivateIpAddress,InstanceType,LaunchTime]',
        '--output', 'text',
        ...base
      ])
      
      const [state, publicIp, privateIp, instanceType, launchTime] = stdout.trim().split('\t')
      sp.succeed('Instance status retrieved')
      
      this.log(chalk.green('Instance Status:'))
      this.log(`  State: ${this.formatState(state)}`)
      this.log(`  Type: ${instanceType}`)
      this.log(`  Public IP: ${publicIp || 'None'}`)
      this.log(`  Private IP: ${privateIp || 'None'}`)
      this.log(`  Launch Time: ${new Date(launchTime).toLocaleString()}`)
      
      // If running, test the endpoint
      if (state === 'running' && publicIp && publicIp !== 'None') {
        this.log('')
        this.log(chalk.blue('Testing Kimi K2 service...'))
        
        const endpoint = `http://${publicIp}:8080`
        const testResult = await this.testEndpoint(endpoint)
        
        if (testResult.success) {
          this.log(chalk.green('Kimi K2 service is running and responding'))
          if (testResult.responseTime) {
            this.log(`   Response time: ${testResult.responseTime}ms`)
          }
        } else {
          this.log(chalk.yellow(`Service not responding: ${testResult.error}`))
          this.log('   The service may still be starting up after instance boot.')
        }
      }
      
    } catch (error: any) {
      sp.fail('Failed to check status')
      if (debug) this.log(chalk.gray(error?.message || String(error)))
      throw error
    }
  }

  private async waitForState(instanceId: string, targetState: string, base: string[], debug: boolean) {
    const sp = ora(`Waiting for instance to be ${targetState}`).start()
    
    const deadline = Date.now() + 5 * 60_000 // 5 minutes
    while (Date.now() < deadline) {
      try {
        const {stdout} = await execFileAsync('aws', [
          'ec2', 'describe-instances',
          '--instance-ids', instanceId,
          '--query', 'Reservations[0].Instances[0].State.Name',
          '--output', 'text',
          ...base
        ])
        
        const currentState = stdout.trim()
        sp.text = `Instance state: ${currentState} (waiting for ${targetState})`
        
        if (currentState === targetState) {
          sp.succeed(`Instance is ${targetState}`)
          return
        }
        
      } catch (e: any) {
        if (debug) this.log(chalk.gray(e?.message || String(e)))
      }
      
      await new Promise(r => setTimeout(r, 5000))
    }
    
    sp.warn(`Timeout waiting for ${targetState} state`)
  }

  private formatState(state: string): string {
    const stateColors: {[key: string]: any} = {
      'pending': chalk.yellow,
      'running': chalk.green,
      'stopping': chalk.yellow,
      'stopped': chalk.red,
      'shutting-down': chalk.red,
      'terminated': chalk.gray,
      'rebooting': chalk.yellow
    }
    
    const colorFn = stateColors[state] || chalk.white
    return colorFn(state)
  }

  private async testEndpoint(endpoint: string): Promise<{
    success: boolean,
    error?: string,
    responseTime?: number
  }> {
    try {
      const startTime = Date.now()
      
      // Simple health check
      await execFileAsync('curl', [
        '-s', '-f', '--connect-timeout', '5', '--max-time', '10',
        `${endpoint}/health`
      ])
      
      const responseTime = Date.now() - startTime
      return { success: true, responseTime }
      
    } catch (error: any) {
      let errorMsg = 'Connection failed'
      const stderr = error?.stderr?.toString?.() || error?.message || String(error)
      
      if (stderr.includes('Connection refused')) {
        errorMsg = 'Service not running'
      } else if (stderr.includes('timeout')) {
        errorMsg = 'Request timeout'
      } else if (stderr.includes('404')) {
        errorMsg = 'Endpoint not found'
      }
      
      return { success: false, error: errorMsg }
    }
  }
}
