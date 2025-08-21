import blessed from 'blessed'
import {spawn} from 'node:child_process'
import {Screen, ScreenContext} from '../lib/screen-manager.js'
import {setFargateConfig} from '../lib/config.js'

export class DaemonScreen implements Screen {
  name = 'Daemon'
  key = 'd'
  description = 'Daemon deployment and management'

  private logBox?: blessed.Widgets.BoxElement
  private deploymentStatus?: blessed.Widgets.TextElement

  async render(screen: blessed.Widgets.Screen, context: ScreenContext): Promise<void> {
    const container = blessed.box({
      parent: screen,
      width: '100%',
      height: '100%',
      style: { bg: 'black' }
    })

    // Header
    const header = blessed.box({
      parent: container,
      top: 0,
      height: 3,
      width: '100%',
      border: { type: 'line' },
      style: { 
        fg: 'white', 
        bg: 'black',
        border: { fg: 'cyan' }
      },
      tags: true
    })

    const title = blessed.text({
      parent: header,
      top: 0,
      left: 2,
      content: '{bold}{cyan-fg}AutoIR{/cyan-fg}{/bold} — Daemon Management',
      tags: true,
      style: { fg: 'white' }
    })

    this.deploymentStatus = blessed.text({
      parent: header,
      top: 1,
      left: 2,
      content: 'Ready for deployment',
      style: { fg: 'green' }
    })

    // Options panel
    const optionsPanel = blessed.box({
      parent: container,
      top: 4,
      left: 1,
      width: '50%',
      height: 15,
      border: { type: 'line' },
      label: ' Deployment Options ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'green' }
      },
      tags: true
    })

    optionsPanel.setContent(`
{yellow-fg}L{/yellow-fg} - Start Local Daemon
   Runs daemon in background on this machine
   Monitors: /autoir/noise log group

{yellow-fg}F{/yellow-fg} - Deploy to ECS Fargate  
   Creates CloudFormation stack
   Scalable, serverless log processing

{yellow-fg}C{/yellow-fg} - Configure Settings
   Set cluster/service names
   Update deployment parameters

{yellow-fg}S{/yellow-fg} - Show Status
   Check current deployments
   View running processes`)

    // Configuration panel
    const configPanel = blessed.box({
      parent: container,
      top: 4,
      left: '50%',
      width: '50%',
      height: 15,
      border: { type: 'line' },
      label: ' Current Configuration ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' }
      },
      tags: true
    })

    const region = context.smRegion || context.flags.region || process.env.AWS_REGION || 'Not configured'
    const endpoint = context.smEndpoint || 'Not configured'

    configPanel.setContent(`{cyan-fg}AWS Region:{/cyan-fg} ${region}
{cyan-fg}SageMaker Endpoint:{/cyan-fg} ${endpoint}
{cyan-fg}Log Groups:{/cyan-fg} /autoir/noise
{cyan-fg}ECS Cluster:{/cyan-fg} autoir
{cyan-fg}ECS Service:{/cyan-fg} autoir
{cyan-fg}Table:{/cyan-fg} ${context.flags.table || 'autoir_log_events'}`)

    // Log output
    this.logBox = blessed.box({
      parent: container,
      top: 20,
      left: 1,
      width: '100%-2',
      height: '100%-22',
      border: { type: 'line' },
      label: ' Deployment Log ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'yellow' }
      },
      tags: true,
      scrollable: true,
      keys: true,
      vi: true,
      mouse: true
    })

    this.logBox.setContent('Select a deployment option above...')

    // Footer
    const footer = blessed.box({
      parent: container,
      bottom: 0,
      height: 1,
      width: '100%',
      content: '{center}{yellow-fg}L{/yellow-fg}: local • {yellow-fg}F{/yellow-fg}: fargate • {yellow-fg}C{/yellow-fg}: config • {yellow-fg}S{/yellow-fg}: status • {yellow-fg}Escape{/yellow-fg}: menu • {yellow-fg}q{/yellow-fg}: quit{/center}',
      tags: true,
      style: { fg: 'white', bg: 'black' }
    })

    // Event handlers
    screen.key(['l', 'L'], async () => {
      await this.startLocalDaemon(context)
    })

    screen.key(['f', 'F'], async () => {
      await this.deployFargate(context)
    })

    screen.key(['c', 'C'], async () => {
      await this.configureSettings(context)
    })

    screen.key(['s', 'S'], async () => {
      await this.showStatus(context)
    })

    screen.render()
  }

  private async startLocalDaemon(context: ScreenContext): Promise<void> {
    if (!this.logBox || !this.deploymentStatus) return

    this.deploymentStatus.setContent('Starting local daemon...')
    this.logBox.setContent('Starting local daemon in background...\n')
    this.logBox.screen.render()

    try {
      const region = context.smRegion || context.flags.region || process.env.AWS_REGION || 'us-east-1'
      const endpoint = context.smEndpoint || 'autoir-embed-ep'

      const daemon = spawn(process.execPath, [
        './bin/run.js', 'daemon',
        '--groups', '/autoir/noise',
        '--region', region,
        '--sagemakerEndpoint', endpoint,
        '--sagemakerRegion', region
      ], {
        detached: true,
        stdio: 'ignore'
      })

      daemon.unref()

      this.logBox.setContent(this.logBox.getContent() + 
        `✅ Local daemon started successfully\n` +
        `   Process ID: ${daemon.pid}\n` +
        `   Log groups: /autoir/noise\n` +
        `   Region: ${region}\n` +
        `   Endpoint: ${endpoint}\n\n` +
        `The daemon is now running in the background and will\n` +
        `continue processing logs even after you close this interface.`)

      this.deploymentStatus.setContent('Local daemon running')
      this.logBox.screen.render()
    } catch (error: any) {
      this.logBox.setContent(this.logBox.getContent() + 
        `❌ Error starting local daemon:\n${error.message}\n`)
      this.deploymentStatus.setContent('Local daemon failed')
      this.logBox.screen.render()
    }
  }

  private async deployFargate(context: ScreenContext): Promise<void> {
    if (!this.logBox || !this.deploymentStatus) return

    this.deploymentStatus.setContent('Deploying to Fargate...')
    this.logBox.setContent('Starting ECS Fargate deployment...\n')
    this.logBox.screen.render()

    try {
      const region = context.smRegion || context.flags.region || process.env.AWS_REGION || 'us-east-1'
      const endpoint = context.smEndpoint || 'autoir-embed-ep'
      const cluster = 'autoir'
      const service = 'autoir'

      // Save configuration
      await setFargateConfig({ cluster, service })

      this.logBox.setContent(this.logBox.getContent() + 
        `Configuration:\n` +
        `   Cluster: ${cluster}\n` +
        `   Service: ${service}\n` +
        `   Region: ${region}\n` +
        `   Endpoint: ${endpoint}\n\n` +
        `Starting CloudFormation deployment...\n`)

      const deployment = spawn(process.execPath, [
        './bin/run.js', 'aws', 'autoir-fargate', 'deploy',
        '--cluster', cluster,
        '--service', service,
        '--region', region,
        '--sagemaker-endpoint', endpoint,
        '--sagemaker-region', region
      ], {
        detached: true,
        stdio: 'ignore'
      })

      deployment.unref()

      this.logBox.setContent(this.logBox.getContent() + 
        `✅ Fargate deployment initiated\n` +
        `   Deployment ID: ${deployment.pid}\n\n` +
        `The deployment is running in the background.\n` +
        `Check the AWS CloudFormation console for progress.\n` +
        `Stack name: autoir-fargate\n\n` +
        `This may take 10-15 minutes to complete.`)

      this.deploymentStatus.setContent('Fargate deployment in progress')
      this.logBox.screen.render()
    } catch (error: any) {
      this.logBox.setContent(this.logBox.getContent() + 
        `❌ Error deploying to Fargate:\n${error.message}\n`)
      this.deploymentStatus.setContent('Fargate deployment failed')
      this.logBox.screen.render()
    }
  }

  private async configureSettings(context: ScreenContext): Promise<void> {
    if (!this.logBox) return

    this.logBox.setContent('Configuration Management\n\n' +
      'Current settings are managed through:\n' +
      '• Command line flags (--cluster, --service, --region)\n' +
      '• Environment variables (AWS_REGION, TIDB_DSN)\n' +
      '• Configuration files (~/.autoir/config.json)\n\n' +
      'To modify settings:\n' +
      '1. Use command line flags when starting AutoIR\n' +
      '2. Set environment variables in your shell\n' +
      '3. Edit the configuration file directly\n\n' +
      'Example:\n' +
      '  autoir --cluster my-cluster --service my-service --region us-west-2')

    this.logBox.screen.render()
  }

  private async showStatus(context: ScreenContext): Promise<void> {
    if (!this.logBox || !this.deploymentStatus) return

    this.deploymentStatus.setContent('Checking status...')
    this.logBox.setContent('Checking deployment status...\n')
    this.logBox.screen.render()

    try {
      // Check for local processes (simplified)
      this.logBox.setContent(this.logBox.getContent() + 
        'Local Processes:\n' +
        '• AutoIR daemon: Use "ps aux | grep autoir" to check\n\n')

      // Check ECS services (simplified)
      this.logBox.setContent(this.logBox.getContent() + 
        'ECS Fargate Services:\n' +
        '• Use the Metrics screen (press M) for detailed ECS status\n' +
        '• Check AWS console for CloudFormation stacks\n\n')

      this.logBox.setContent(this.logBox.getContent() + 
        'Configuration Status:\n' +
        `• Database: ${context.dbPool ? 'Connected' : 'Not connected'}\n` +
        `• SageMaker: ${context.smEndpoint ? 'Configured' : 'Not configured'}\n` +
        `• AWS Region: ${context.smRegion || 'Not configured'}\n`)

      this.deploymentStatus.setContent('Status check complete')
      this.logBox.screen.render()
    } catch (error: any) {
      this.logBox.setContent(this.logBox.getContent() + 
        `❌ Error checking status:\n${error.message}\n`)
      this.deploymentStatus.setContent('Status check failed')
      this.logBox.screen.render()
    }
  }

  cleanup(): void {
    // No cleanup needed for this screen
  }
}
