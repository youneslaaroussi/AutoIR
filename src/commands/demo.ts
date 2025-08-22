import {Command, Flags} from '@oclif/core'
import {spawn} from 'node:child_process'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import chalk from 'chalk'
import ora from 'ora'
import blessed from 'blessed'
import contrib from 'blessed-contrib'
import {getDatabase} from '../lib/db-factory.js'
import {getMockECS, getMockSageMaker, getMockCloudWatchLogs} from '../lib/mock-aws.js'
import {SlackClient} from '../lib/slack.js'

export default class Demo extends Command {
  static description = 'Run the complete AutoIR demo with real-time dashboard and impressive fake AWS integration'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --full-screen',
  ]

  static flags = {
    'full-screen': Flags.boolean({description: 'Run in full-screen dashboard mode', default: false}),
    'skip-docker': Flags.boolean({description: 'Skip Docker daemon and run services locally', default: false}),
    'slack-demo': Flags.boolean({description: 'Send demo incidents to Slack', default: false}),
  }

  private screen?: blessed.Widgets.Screen & {
    logsBox?: any
    incidentsBox?: any
    alertsBox?: any
    healthBox?: any
    logStream?: any
    awsStatus?: any
    tidbStatus?: any
  }
  private isRunning = false
  private stats = {
    logsProcessed: 0,
    incidentsDetected: 0,
    alertsSent: 0,
    systemHealth: 98.7,
    startTime: Date.now()
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Demo)

    this.log(chalk.blue.bold('🚀 AutoIR Complete Demo System'))
    this.log(chalk.gray('Showcasing AI-powered incident response with TiDB + AWS'))
    this.log()

    if (flags['full-screen']) {
      await this.runFullScreenDemo(flags)
    } else {
      await this.runConsoleDemo(flags)
    }
  }

  private async runConsoleDemo(flags: any): Promise<void> {
    // Initialize all systems
    await this.initializeSystems()

    // Start Docker daemon if requested
    if (!flags['skip-docker']) {
      await this.startDockerDaemon()
    }

    // Start local services
    await this.startLocalServices(flags)

    // Keep running
    this.isRunning = true
    process.on('SIGINT', () => this.stop())
    process.on('SIGTERM', () => this.stop())

    this.log()
    this.log(chalk.green.bold('✅ Demo system is now running!'))
    this.log()
    this.log(chalk.cyan('Demo Features Active:'))
    this.log('  • Real-time log processing and vector embedding')
    this.log('  • AI-powered incident detection and classification')
    this.log('  • Slack notifications with rich incident reports')
    this.log('  • Mock AWS Fargate showing realistic metrics')
    this.log('  • TiDB vector similarity search with demo data')
    this.log()
    this.log(chalk.yellow('Press Ctrl+C to stop the demo'))

    // Show periodic status updates
    this.showPeriodicUpdates()
  }

  private async runFullScreenDemo(flags: any): Promise<void> {
    // Initialize blessed screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'AutoIR Demo Dashboard'
    })

    // Initialize all systems
    await this.initializeSystems()

    // Create dashboard layout
    await this.createDashboard()

    // Start services
    if (!flags['skip-docker']) {
      await this.startDockerDaemon()
    }
    await this.startLocalServices(flags)

    // Start dashboard updates
    this.isRunning = true
    this.updateDashboard()

    // Handle exit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop()
    })

    this.screen.render()
  }

  private async initializeSystems(): Promise<void> {
    const spinner = ora('Initializing AutoIR systems...').start()

    try {
      // Initialize database
      const db = await getDatabase()
      spinner.succeed('Database initialized (using mock TiDB with vector support)')

      // Initialize AWS services
      const ecs = await getMockECS()
      const sagemaker = await getMockSageMaker('autoir-embed-ep-srv')
      const cloudwatch = await getMockCloudWatchLogs()
      
      spinner.succeed('AWS services initialized (SageMaker, ECS, CloudWatch)')

      // Try Slack
      try {
        const slack = new SlackClient()
        await slack.initialize()
        spinner.succeed('Slack integration ready')
      } catch {
        spinner.warn('Slack not configured (optional)')
      }

    } catch (error) {
      spinner.fail(`Initialization failed: ${error}`)
      throw error
    }
  }

  private async startDockerDaemon(): Promise<void> {
    const spinner = ora('Starting AutoIR Fargate daemon...').start()

    try {
      // Check if script exists
      const scriptPath = path.join(process.cwd(), 'scripts', 'run-demo-fargate.sh')
      await fs.access(scriptPath)

      // Run the script in background
      const child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: 'ignore'
      })

      child.unref()
      
      // Wait a moment for startup
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      spinner.succeed('Fargate daemon started (running in Docker locally)')
    } catch (error) {
      spinner.warn('Could not start Docker daemon, continuing with local services only')
    }
  }

  private async startLocalServices(flags: any): Promise<void> {
    // Start log processing simulation
    this.simulateLogProcessing()
    
    // Start incident generation
    this.simulateIncidentDetection()
    
    // Start Slack demo if requested
    if (flags['slack-demo']) {
      this.startSlackDemo()
    }
  }

  private async simulateLogProcessing(): Promise<void> {
    if (!this.isRunning) return

    const db = await getDatabase()
    const cloudwatch = await getMockCloudWatchLogs()
    const sagemaker = await getMockSageMaker('autoir-embed-ep-srv')

    // Simulate processing logs
    const logGroups = await cloudwatch.describeLogGroups()
    const randomGroup = logGroups[Math.floor(Math.random() * logGroups.length)]
    const events = await cloudwatch.getLogEvents(randomGroup.logGroupName, undefined, 3)

    for (const event of events) {
      const embedding = await sagemaker.invokeEndpoint(event.message)
      await db.insertLogEvent({
        log_group: randomGroup.logGroupName,
        log_stream: event.logStreamName,
        ts_ms: event.timestamp,
        message: event.message,
        embedding
      })
      this.stats.logsProcessed++
    }

    if (events.length > 0 && !this.screen) {
      console.log(chalk.blue(`📝 Processed ${events.length} logs from ${randomGroup.logGroupName}`))
    }

    // Schedule next processing
    setTimeout(() => this.simulateLogProcessing(), 3000 + Math.random() * 7000)
  }

  private async simulateIncidentDetection(): Promise<void> {
    if (!this.isRunning) return

    // Randomly generate incidents
    if (Math.random() < 0.25) { // 25% chance
      const incidents = [
        {
          severity: 'critical' as const,
          title: 'Database Connection Pool Exhaustion',
          summary: 'Multiple services experiencing timeouts. Pool utilization at 98%.',
        },
        {
          severity: 'high' as const,
          title: 'API Gateway Rate Limiting Triggered',
          summary: 'Unusual traffic spike detected from multiple IPs.',
        },
        {
          severity: 'medium' as const,
          title: 'Lambda Memory Utilization Spike',
          summary: 'Memory usage exceeded 90% across payment functions.',
        }
      ]

      const incident = incidents[Math.floor(Math.random() * incidents.length)]
      const db = await getDatabase()
      
      await db.insertIncident({
        created_ms: Date.now(),
        updated_ms: Date.now(),
        status: 'open',
        ...incident,
        event_count: Math.floor(Math.random() * 50) + 10,
        dedupe_key: `${incident.title.replace(/\s+/g, '_')}_${Date.now()}`
      })

      this.stats.incidentsDetected++

      if (!this.screen) {
        console.log(chalk.red(`🚨 INCIDENT: ${incident.title} (${incident.severity.toUpperCase()})`))
      }
    }

    // Schedule next detection
    setTimeout(() => this.simulateIncidentDetection(), 10000 + Math.random() * 20000)
  }

  private async startSlackDemo(): Promise<void> {
    try {
      const slack = new SlackClient()
      await slack.initialize()
      
      // Send periodic demo reports
      setInterval(async () => {
        if (!this.isRunning) return

        if (Math.random() < 0.3) { // 30% chance every interval
          await slack.sendAIAnalysisUpdate(slack.getDefaultChannel(), {
            logVolume: `${(Math.random() * 30 + 15).toFixed(1)}K events/min`,
            anomaliesDetected: Math.floor(Math.random() * 12 + 3),
            predictionAccuracy: `${(Math.random() * 8 + 87).toFixed(1)}%`,
            modelPerformance: `${(Math.random() * 15 + 80).toFixed(1)}% efficiency`,
            insights: [
              'Database connection patterns show correlation with user activity spikes',
              'Payment service latency increases during high memory utilization',
              'API gateway successfully blocked 1.8K suspicious requests',
              'Auto-scaling prevented potential service degradation'
            ]
          })
          this.stats.alertsSent++
        }
      }, 45000) // Every 45 seconds

    } catch (error) {
      console.log(chalk.yellow('Slack demo disabled (not configured)'))
    }
  }

  private async createDashboard(): Promise<void> {
    if (!this.screen) return

    const grid = new contrib.grid({rows: 12, cols: 12, screen: this.screen})

    // Title
    const title = grid.set(0, 0, 1, 12, blessed.box, {
      content: ' AutoIR - AI-Powered Incident Response Demo ',
      style: {fg: 'white', bg: 'blue'},
      align: 'center'
    })

    // Stats boxes
    const logsBox = grid.set(1, 0, 2, 3, blessed.box, {
      label: 'Logs Processed',
      border: {type: 'line'},
      style: {border: {fg: 'cyan'}}
    })

    const incidentsBox = grid.set(1, 3, 2, 3, blessed.box, {
      label: 'Incidents Detected',
      border: {type: 'line'},
      style: {border: {fg: 'red'}}
    })

    const alertsBox = grid.set(1, 6, 2, 3, blessed.box, {
      label: 'Alerts Sent',
      border: {type: 'line'},
      style: {border: {fg: 'yellow'}}
    })

    const healthBox = grid.set(1, 9, 2, 3, blessed.box, {
      label: 'System Health',
      border: {type: 'line'},
      style: {border: {fg: 'green'}}
    })

    // Log stream
    const logStream = grid.set(3, 0, 5, 12, blessed.log, {
      label: 'Real-time Activity Feed',
      border: {type: 'line'},
      style: {border: {fg: 'white'}},
      scrollable: true,
      alwaysScroll: true
    })

    // AWS Services Status
    const awsStatus = grid.set(8, 0, 4, 6, blessed.box, {
      label: 'AWS Services Status',
      border: {type: 'line'},
      style: {border: {fg: 'blue'}},
      content: this.getAWSStatusContent()
    })

    // TiDB Status
    const tidbStatus = grid.set(8, 6, 4, 6, blessed.box, {
      label: 'TiDB Vector Database',
      border: {type: 'line'},
      style: {border: {fg: 'magenta'}},
      content: this.getTiDBStatusContent()
    })

    // Store references for updates
    this.screen.logsBox = logsBox
    this.screen.incidentsBox = incidentsBox
    this.screen.alertsBox = alertsBox
    this.screen.healthBox = healthBox
    this.screen.logStream = logStream
    this.screen.awsStatus = awsStatus
    this.screen.tidbStatus = tidbStatus
  }

  private updateDashboard(): void {
    if (!this.isRunning || !this.screen) return

    // Update stats
    this.screen.logsBox.setContent(`\n  ${this.stats.logsProcessed.toLocaleString()}`)
    this.screen.incidentsBox.setContent(`\n  ${this.stats.incidentsDetected}`)
    this.screen.alertsBox.setContent(`\n  ${this.stats.alertsSent}`)
    this.screen.healthBox.setContent(`\n  ${this.stats.systemHealth.toFixed(1)}%`)

    // Update AWS status
    this.screen.awsStatus.setContent(this.getAWSStatusContent())
    this.screen.tidbStatus.setContent(this.getTiDBStatusContent())

    // Add activity log
    const activities = [
      'Vector embedding generated for payment log',
      'Anomaly detected in API response times',
      'Incident auto-resolved: Database connection restored',
      'SageMaker endpoint processed 1.2K requests',
      'TiDB vector search completed in 45ms',
      'Slack alert sent for critical incident'
    ]

    if (Math.random() < 0.7) {
      const activity = activities[Math.floor(Math.random() * activities.length)]
      this.screen.logStream.log(`${new Date().toLocaleTimeString()} - ${activity}`)
    }

    this.screen.render()

    // Schedule next update
    setTimeout(() => this.updateDashboard(), 2000)
  }

  private getAWSStatusContent(): string {
    const uptime = Math.floor((Date.now() - this.stats.startTime) / 1000)
    return `
  ECS Fargate:     RUNNING
  SageMaker:       InService
  CloudWatch:      ACTIVE
  SNS:             READY
  
  Uptime:          ${Math.floor(uptime / 60)}m ${uptime % 60}s
  CPU Usage:       ${(Math.random() * 30 + 25).toFixed(1)}%
  Memory:          ${(Math.random() * 40 + 40).toFixed(1)}%
  Network I/O:     ${(Math.random() * 500 + 100).toFixed(0)} KB/s
    `
  }

  private getTiDBStatusContent(): string {
    return `
  Status:          CONNECTED
  Vector Index:    HNSW (384d)
  Query Latency:   ${(Math.random() * 50 + 20).toFixed(0)}ms
  
  Log Events:      ${(this.stats.logsProcessed + 500).toLocaleString()}
  Incidents:       ${this.stats.incidentsDetected + 12}
  Vector Ops:      ${Math.floor(Math.random() * 1000 + 500)}/min
  Cache Hit:       ${(Math.random() * 10 + 85).toFixed(1)}%
    `
  }

  private showPeriodicUpdates(): void {
    if (!this.isRunning) return

    const uptime = Math.floor((Date.now() - this.stats.startTime) / 1000)
    
    console.log()
    console.log(chalk.gray('═'.repeat(60)))
    console.log(chalk.blue.bold('📊 AutoIR Demo Status Update'))
    console.log(chalk.gray(`   Runtime: ${Math.floor(uptime / 60)}m ${uptime % 60}s`))
    console.log(chalk.gray(`   Logs Processed: ${this.stats.logsProcessed.toLocaleString()}`))
    console.log(chalk.gray(`   Incidents Detected: ${this.stats.incidentsDetected}`))
    console.log(chalk.gray(`   Alerts Sent: ${this.stats.alertsSent}`))
    console.log(chalk.gray(`   System Health: ${this.stats.systemHealth.toFixed(1)}%`))
    console.log(chalk.gray('═'.repeat(60)))
    console.log()

    setTimeout(() => this.showPeriodicUpdates(), 30000) // Every 30 seconds
  }

  private stop(): void {
    this.isRunning = false
    
    if (this.screen) {
      this.screen.destroy()
    }
    
    console.log()
    console.log(chalk.yellow.bold('🛑 Stopping AutoIR Demo...'))
    console.log(chalk.green('✅ Demo stopped successfully'))
    process.exit(0)
  }
}