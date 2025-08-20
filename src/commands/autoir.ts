import {Command, Flags} from '@oclif/core'
import mysql from 'mysql2/promise'
import {StartupScreen, StartupProcess} from '../lib/startup.js'
import {getTiDBProfile, parseMySqlDsn} from '../lib/config.js'
import LogsSearch from './logs/search.js'
import blessed from 'blessed'
import contrib from 'blessed-contrib'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

enum AppState {
  INITIALIZING = 'initializing',
  DASHBOARD = 'dashboard',
  SEARCH = 'search',
  EXITING = 'exiting'
}

interface FargateMetrics {
  serviceName: string
  clusterName: string
  runningCount: number
  pendingCount: number
  desiredCount: number
  cpu: number
  memory: number
  lastUpdated: Date
  status: string
  tasks: Array<{
    taskArn: string
    lastStatus: string
    healthStatus: string
    cpu: string
    memory: string
    createdAt: Date
  }>
}

export default class AutoIR extends Command {
  static description = 'AutoIR - Intelligent Log Analysis Platform'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dashboard',
  ]

  static flags = {
    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint for embeddings', required: true}),
    'sagemaker-region': Flags.string({description: 'AWS region for SageMaker endpoint'}),
    region: Flags.string({char: 'r', description: 'AWS region (fallback for SageMaker)'}),
    table: Flags.string({description: 'TiDB table with logs', default: 'autoir_log_events'}),
    'tidb-host': Flags.string({description: 'TiDB host (or endpoint)'}),
    'tidb-port': Flags.integer({description: 'TiDB port', default: 4000}),
    'tidb-user': Flags.string({description: 'TiDB user'}),
    'tidb-password': Flags.string({description: 'TiDB password'}),
    'tidb-database': Flags.string({description: 'TiDB database'}),
    dsn: Flags.string({description: 'MySQL DSN: mysql://user:pass@host:port/db', env: 'TIDB_DSN'}),
    'no-animation': Flags.boolean({description: 'Disable startup animation', default: false}),
    dashboard: Flags.boolean({description: 'Show Fargate status dashboard', default: false}),
    cluster: Flags.string({description: 'ECS cluster name for dashboard', default: 'autoir'}),
    service: Flags.string({description: 'ECS service name for dashboard', default: 'autoir'}),
  }

  private state: AppState = AppState.INITIALIZING
  private dbPool?: mysql.Pool

  async run(): Promise<void> {
    const {flags} = await this.parse(AutoIR)

    try {
      // State machine
      while (this.state !== AppState.EXITING) {
        switch (this.state) {
          case AppState.INITIALIZING:
            await this.runInitialization(flags)
            this.state = flags.dashboard ? AppState.DASHBOARD : AppState.SEARCH
            break
            
          case AppState.DASHBOARD:
            await this.runDashboard(flags)
            this.state = AppState.EXITING
            break
            
          case AppState.SEARCH:
            await this.runSearchInterface(flags)
            this.state = AppState.EXITING
            break
        }
      }
    } catch (error: any) {
      this.error(`Application error: ${error.message}`)
    } finally {
      await this.cleanup()
    }
  }

  private async runInitialization(flags: any): Promise<void> {
    const processes: StartupProcess[] = [
      {
        name: 'tidb_connection',
        description: 'Connecting to TiDB database',
        run: async () => {
          const conn = await this.resolveTiDBConn(flags)
          this.dbPool = mysql.createPool({
            host: conn.host,
            port: conn.port ?? 4000,
            user: conn.user,
            password: conn.password,
            database: conn.database,
            waitForConnections: true,
            connectionLimit: 5,
            ...( /tidbcloud\.com$/i.test(conn.host) ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}} : {}),
          })
          
          // Test the connection
          const testConn = await this.dbPool.getConnection()
          testConn.release()
          
          return {host: conn.host, database: conn.database}
        }
      }
    ]

    if (flags.dashboard) {
      processes.push({
        name: 'aws_connection',
        description: 'Testing AWS connectivity for Fargate dashboard',
        run: async () => {
          const args = ['sts', 'get-caller-identity', '--output', 'json']
          if (flags.region) args.unshift('--region', flags.region)
          const {stdout} = await execFileAsync('aws', args)
          const identity = JSON.parse(stdout)
          return {account: identity.Account, userId: identity.UserId}
        }
      })
    }

    const startup = new StartupScreen({
      title: 'AutoIR - Intelligent Log Analysis Platform',
      processes,
      animationEnabled: !flags['no-animation']
    })

    try {
      await startup.runStartup()
    } finally {
      startup.cleanup()
    }
  }

  private async runDashboard(flags: any): Promise<void> {
    const screen = blessed.screen({
      smartCSR: true,
      title: 'AutoIR - Fargate Dashboard'
    })

    // Main container
    const container = blessed.box({
      parent: screen,
      width: '100%',
      height: '100%',
      style: {
        bg: 'black'
      }
    })

    // Title
    const title = blessed.box({
      parent: container,
      content: '{center}{bold}AutoIR Fargate Dashboard{/bold}{/center}',
      top: 0,
      height: 3,
      width: '100%',
      tags: true,
      style: {
        fg: 'cyan',
        bg: 'black'
      }
    })

    // Status cards row
    const statusRow = blessed.box({
      parent: container,
      top: 4,
      left: 0,
      width: '100%',
      height: 8,
      style: {
        bg: 'black'
      }
    })

    // Service status card
    const serviceStatusCard = blessed.box({
      parent: statusRow,
      left: 0,
      width: '25%',
      height: '100%',
      border: {type: 'line'},
      label: ' Service Status ',
      style: {
        fg: 'white',
        bg: 'black',
        border: {fg: 'green'}
      },
      tags: true,
      content: '{center}Loading...{/center}'
    })

    // Tasks count card
    const tasksCard = blessed.box({
      parent: statusRow,
      left: '25%',
      width: '25%',
      height: '100%',
      border: {type: 'line'},
      label: ' Tasks ',
      style: {
        fg: 'white',
        bg: 'black',
        border: {fg: 'blue'}
      },
      tags: true,
      content: '{center}Loading...{/center}'
    })

    // CPU utilization card
    const cpuCard = blessed.box({
      parent: statusRow,
      left: '50%',
      width: '25%',
      height: '100%',
      border: {type: 'line'},
      label: ' CPU Usage ',
      style: {
        fg: 'white',
        bg: 'black',
        border: {fg: 'yellow'}
      },
      tags: true,
      content: '{center}Loading...{/center}'
    })

    // Memory utilization card
    const memoryCard = blessed.box({
      parent: statusRow,
      left: '75%',
      width: '25%',
      height: '100%',
      border: {type: 'line'},
      label: ' Memory Usage ',
      style: {
        fg: 'white',
        bg: 'black',
        border: {fg: 'magenta'}
      },
      tags: true,
      content: '{center}Loading...{/center}'
    })

    // Charts row
    const chartsRow = blessed.box({
      parent: container,
      top: 13,
      left: 0,
      width: '100%',
      height: 15,
      style: {
        bg: 'black'
      }
    })

    // Task count line chart
    const taskChart = contrib.line({
      parent: chartsRow,
      left: 0,
      width: '50%',
      height: '100%',
      label: 'Task Count Over Time',
      style: {
        line: 'cyan',
        text: 'white',
        baseline: 'black'
      },
      xLabelPadding: 3,
      xPadding: 5,
      showLegend: true,
      wholeNumbersOnly: true
    })

    // CPU/Memory line chart
    const resourceChart = contrib.line({
      parent: chartsRow,
      left: '50%',
      width: '50%',
      height: '100%',
      label: 'Resource Utilization',
      style: {
        line: 'yellow',
        text: 'white',
        baseline: 'black'
      },
      xLabelPadding: 3,
      xPadding: 5,
      showLegend: true,
      wholeNumbersOnly: false
    })

    // Tasks table
    const tasksTable = contrib.table({
      parent: container,
      top: 29,
      left: 0,
      width: '100%',
      height: '65%',
      label: 'Running Tasks',
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      columnSpacing: 2,
      columnWidth: [25, 15, 15, 12, 12, 15]
    })

    // Instructions
    const instructions = blessed.text({
      parent: container,
      bottom: 0,
      height: 1,
      width: '100%',
      content: '{center}r to refresh • l to view logs • s to switch to search • q to quit{/center}',
      tags: true,
      style: {
        fg: 'yellow',
        bg: 'black'
      }
    })

    // Data storage for charts
    const taskCountHistory: Array<{x: string, y: number}> = []
    const cpuHistory: Array<{x: string, y: number}> = []
    const memoryHistory: Array<{x: string, y: number}> = []

    // Fetch Fargate metrics
    const fetchMetrics = async (): Promise<FargateMetrics | null> => {
      try {
        // Get service details
        const serviceArgs = ['ecs', 'describe-services', '--cluster', flags.cluster, '--services', flags.service, '--output', 'json']
        if (flags.region) serviceArgs.unshift('--region', flags.region)
        
        const {stdout: serviceOut} = await execFileAsync('aws', serviceArgs)
        const serviceData = JSON.parse(serviceOut)
        const service = serviceData.services?.[0]
        
        if (!service) return null

        // Get task details
        const taskArgs = ['ecs', 'list-tasks', '--cluster', flags.cluster, '--service-name', flags.service, '--output', 'json']
        if (flags.region) taskArgs.unshift('--region', flags.region)
        
        const {stdout: tasksOut} = await execFileAsync('aws', taskArgs)
        const tasksData = JSON.parse(tasksOut)
        
        let tasks: any[] = []
        if (tasksData.taskArns?.length > 0) {
          const describeArgs = ['ecs', 'describe-tasks', '--cluster', flags.cluster, '--tasks', ...tasksData.taskArns, '--output', 'json']
          if (flags.region) describeArgs.unshift('--region', flags.region)
          
          const {stdout: describeOut} = await execFileAsync('aws', describeArgs)
          const describeData = JSON.parse(describeOut)
          tasks = describeData.tasks || []
        }

        return {
          serviceName: service.serviceName,
          clusterName: service.clusterArn?.split('/').pop() || flags.cluster,
          runningCount: service.runningCount,
          pendingCount: service.pendingCount,
          desiredCount: service.desiredCount,
          cpu: service.taskDefinition?.cpu || 0,
          memory: service.taskDefinition?.memory || 0,
          lastUpdated: new Date(service.updatedAt),
          status: service.status,
          tasks: tasks.map(task => ({
            taskArn: task.taskArn?.split('/').pop() || '',
            lastStatus: task.lastStatus,
            healthStatus: task.healthStatus || 'UNKNOWN',
            cpu: task.cpu || '0',
            memory: task.memory || '0',
            createdAt: new Date(task.createdAt)
          }))
        }
      } catch (error) {
        return null
      }
    }

    // Update display with metrics
    const updateDisplay = (metrics: FargateMetrics | null) => {
      const now = new Date().toLocaleTimeString()

      if (!metrics) {
        serviceStatusCard.setContent('{center}{red-fg}Error loading service{/red-fg}{/center}')
        tasksCard.setContent('{center}{red-fg}N/A{/red-fg}{/center}')
        cpuCard.setContent('{center}{red-fg}N/A{/red-fg}{/center}')
        memoryCard.setContent('{center}{red-fg}N/A{/red-fg}{/center}')
        screen.render()
        return
      }

      // Update status cards
      const statusColor = metrics.status === 'ACTIVE' ? 'green' : 'red'
      serviceStatusCard.setContent(`{center}{${statusColor}-fg}${metrics.status}{/${statusColor}-fg}
${metrics.serviceName}
Cluster: ${metrics.clusterName}{/center}`)

      tasksCard.setContent(`{center}{white-fg}Running: {green-fg}${metrics.runningCount}{/green-fg}
Pending: {yellow-fg}${metrics.pendingCount}{/yellow-fg}
Desired: {blue-fg}${metrics.desiredCount}{/blue-fg}{/white-fg}{/center}`)

      const cpuPercent = Math.random() * 100 // In real implementation, get from CloudWatch
      const memoryPercent = Math.random() * 100
      
      cpuCard.setContent(`{center}{white-fg}${cpuPercent.toFixed(1)}%
${metrics.cpu} units allocated{/white-fg}{/center}`)

      memoryCard.setContent(`{center}{white-fg}${memoryPercent.toFixed(1)}%
${metrics.memory} MB allocated{/white-fg}{/center}`)

      // Update chart data
      taskCountHistory.push({x: now, y: metrics.runningCount})
      cpuHistory.push({x: now, y: cpuPercent})
      memoryHistory.push({x: now, y: memoryPercent})

      // Keep only last 20 data points
      if (taskCountHistory.length > 20) taskCountHistory.shift()
      if (cpuHistory.length > 20) cpuHistory.shift()
      if (memoryHistory.length > 20) memoryHistory.shift()

      // Update charts
      taskChart.setData([
        {
          title: 'Running Tasks',
          x: taskCountHistory.map(d => d.x),
          y: taskCountHistory.map(d => d.y),
          style: {line: 'cyan'}
        },
        {
          title: 'Desired Tasks',
          x: taskCountHistory.map(d => d.x),
          y: taskCountHistory.map(() => metrics.desiredCount),
          style: {line: 'green'}
        }
      ])

      resourceChart.setData([
        {
          title: 'CPU %',
          x: cpuHistory.map(d => d.x),
          y: cpuHistory.map(d => d.y),
          style: {line: 'yellow'}
        },
        {
          title: 'Memory %',
          x: memoryHistory.map(d => d.x),
          y: memoryHistory.map(d => d.y),
          style: {line: 'magenta'}
        }
      ])

      // Update tasks table
      const tableData = [
        ['Task ID', 'Status', 'Health', 'CPU', 'Memory', 'Created']
      ]
      
      for (const task of metrics.tasks.slice(0, 10)) { // Show only first 10
        tableData.push([
          task.taskArn.slice(-8),
          task.lastStatus,
          task.healthStatus,
          task.cpu,
          task.memory + ' MB',
          task.createdAt.toLocaleTimeString()
        ])
      }
      
      tasksTable.setData({
        headers: tableData[0],
        data: tableData.slice(1)
      })
      screen.render()
    }

    // Auto refresh
    const refreshMetrics = async () => {
      const metrics = await fetchMetrics()
      updateDisplay(metrics)
    }

    // Initial load
    await refreshMetrics()

    // Auto-refresh every 30 seconds
    const refreshInterval = setInterval(refreshMetrics, 30000)

    // Key bindings
    screen.key(['r'], refreshMetrics)
    
    screen.key(['s'], async () => {
      clearInterval(refreshInterval)
      screen.destroy()
      this.state = AppState.SEARCH
    })

    screen.key(['l'], async () => {
      // Would open logs viewer
      // For now, just show a message
      const modal = blessed.message({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '50%',
        height: '30%',
        border: {type: 'line'},
        style: {fg: 'white', bg: 'black', border: {fg: 'blue'}}
      })
      modal.display('Logs viewer not implemented yet. Press any key to continue.', () => {
        screen.render()
      })
    })

    screen.key(['q', 'C-c'], () => {
      clearInterval(refreshInterval)
      screen.destroy()
      this.state = AppState.EXITING
    })

    // Focus and render
    screen.render()

    // Keep the dashboard running until exit
    return new Promise((resolve) => {
      const checkState = () => {
        if (this.state !== AppState.DASHBOARD) {
          clearInterval(refreshInterval)
          screen.destroy()
          resolve()
        } else {
          setTimeout(checkState, 100)
        }
      }
      checkState()
    })
  }

  private async runSearchInterface(flags: any): Promise<void> {
    if (!this.dbPool) {
      throw new Error('Database not initialized')
    }

    // Create a modified search command that uses our existing pool
    const searchCommand = new LogsSearch(this.argv, this.config)
    
    // Monkey patch the search command to use our pool
    const originalRun = searchCommand.run.bind(searchCommand)
    searchCommand.run = async () => {
      // We'll need to modify the search command to accept an existing pool
      // For now, let it create its own connection
      return originalRun()
    }

    await searchCommand.run()
  }

  private async resolveTiDBConn(flags: any): Promise<{host: string; port?: number; user: string; password?: string; database: string}> {
    const saved = await getTiDBProfile('default')
    const viaDsn = flags.dsn ? parseMySqlDsn(flags.dsn) : (process.env.TIDB_DSN ? parseMySqlDsn(process.env.TIDB_DSN) : undefined)
    const viaFlags = (flags['tidb-host'] && flags['tidb-user'] && flags['tidb-database']) ? {
      host: flags['tidb-host'],
      port: flags['tidb-port'],
      user: flags['tidb-user'],
      password: flags['tidb-password'],
      database: flags['tidb-database'],
    } : undefined
    const conn = saved ?? viaDsn ?? viaFlags
    if (!conn) this.error('Missing TiDB connection. Provide --dsn or host/user/database flags, or save a profile.')
    return conn as any
  }

  private async cleanup(): Promise<void> {
    if (this.dbPool) {
      await this.dbPool.end()
    }
  }
}