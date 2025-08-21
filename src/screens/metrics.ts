import blessed from 'blessed'
import contrib from 'blessed-contrib'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Screen, ScreenContext} from '../lib/screen-manager.js'
import {getFargateConfig} from '../lib/config.js'

const execFileAsync = promisify(execFile)

export class MetricsScreen implements Screen {
  name = 'Metrics'
  key = 'm'
  description = 'ECS Fargate metrics and monitoring'

  private serviceCard?: blessed.Widgets.BoxElement
  private tasksCard?: blessed.Widgets.BoxElement
  private cpuCard?: blessed.Widgets.BoxElement
  private memoryCard?: blessed.Widgets.BoxElement
  private tasksTable?: any
  private refreshInterval?: NodeJS.Timeout

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
      content: '{bold}{cyan-fg}AutoIR{/cyan-fg}{/bold} — ECS Fargate Metrics',
      tags: true,
      style: { fg: 'white' }
    })

    const statusText = blessed.text({
      parent: header,
      top: 1,
      left: 2,
      content: `Last Updated: ${new Date().toLocaleTimeString()}`,
      style: { fg: 'green' }
    })

    // Metrics cards row
    const metricsRow = blessed.box({
      parent: container,
      top: 4,
      left: 1,
      width: '100%-2',
      height: 8,
      style: { bg: 'black' }
    })

    this.serviceCard = blessed.box({
      parent: metricsRow,
      left: 0,
      width: '25%',
      height: '100%',
      border: { type: 'line' },
      label: ' Service Status ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'green' }
      },
      tags: true,
      content: '{center}{yellow-fg}●{/yellow-fg} Loading...\n{gray-fg}autoir{/gray-fg}{/center}'
    })

    this.tasksCard = blessed.box({
      parent: metricsRow,
      left: '25%',
      width: '25%',
      height: '100%',
      border: { type: 'line' },
      label: ' Tasks ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'blue' }
      },
      tags: true,
      content: '{center}{yellow-fg}0{/yellow-fg} Running\n{gray-fg}Loading...{/gray-fg}{/center}'
    })

    this.cpuCard = blessed.box({
      parent: metricsRow,
      left: '50%',
      width: '25%',
      height: '100%',
      border: { type: 'line' },
      label: ' CPU Usage ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'yellow' }
      },
      tags: true,
      content: '{center}{white-fg}N/A\nNo data{/white-fg}{/center}'
    })

    this.memoryCard = blessed.box({
      parent: metricsRow,
      left: '75%',
      width: '25%',
      height: '100%',
      border: { type: 'line' },
      label: ' Memory Usage ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'magenta' }
      },
      tags: true,
      content: '{center}{white-fg}N/A\nNo data{/white-fg}{/center}'
    })

    // System info section
    const systemInfo = blessed.box({
      parent: container,
      top: 13,
      left: 1,
      width: '50%',
      height: 10,
      border: { type: 'line' },
      label: ' System Information ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' }
      },
      tags: true,
      scrollable: true
    })

    // Configuration section
    const configInfo = blessed.box({
      parent: container,
      top: 13,
      left: '50%',
      width: '50%',
      height: 10,
      border: { type: 'line' },
      label: ' Configuration ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'green' }
      },
      tags: true,
      scrollable: true
    })

    // Tasks table
    this.tasksTable = contrib.table({
      parent: container,
      top: 24,
      left: 1,
      width: '100%-2',
      height: '100%-26',
      label: ' Running Tasks ',
      keys: true,
      vi: true,
      mouse: true,
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'blue' },
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
        selected: { fg: 'black', bg: 'cyan' }
      },
      columnSpacing: 1,
      columnWidth: [20, 15, 15, 15, 15, 20]
    })

    // Footer
    const footer = blessed.box({
      parent: container,
      bottom: 0,
      height: 1,
      width: '100%',
      content: '{center}{yellow-fg}r{/yellow-fg}: refresh • {yellow-fg}Escape{/yellow-fg}: menu • {yellow-fg}q{/yellow-fg}: quit{/center}',
      tags: true,
      style: { fg: 'white', bg: 'black' }
    })

    // Update system info
    const updateSystemInfo = () => {
      const region = context.smRegion || context.flags.region || process.env.AWS_REGION || 'Not configured'
      const endpoint = context.smEndpoint || 'Not configured'
      
      systemInfo.setContent(`{white-fg}AWS Region:{/white-fg} ${region}
{white-fg}SageMaker Endpoint:{/white-fg} ${endpoint ? 'Ready' : 'Not configured'}
{white-fg}Database:{/white-fg} ${context.dbPool ? 'Connected' : 'Not connected'}
{white-fg}Process Uptime:{/white-fg} ${Math.floor(process.uptime())}s
{white-fg}Memory Usage:{/white-fg} ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`)

      configInfo.setContent(`{cyan-fg}Table:{/cyan-fg} ${context.flags.table || 'autoir_log_events'}
{cyan-fg}Cluster:{/cyan-fg} autoir
{cyan-fg}Service:{/cyan-fg} autoir
{cyan-fg}Auto-refresh:{/cyan-fg} 30s`)
      
      screen.render()
    }

    // Metrics refresh function
    const refreshMetrics = async () => {
      try {
        const fargateCfg = await getFargateConfig()
        const cluster = context.flags.cluster || fargateCfg?.cluster || 'autoir'
        const service = context.flags.service || fargateCfg?.service || 'autoir'

        try {
          const {stdout} = await execFileAsync('aws', [
            'ecs', 'describe-services', 
            '--cluster', cluster, 
            '--services', service, 
            '--output', 'json'
          ], {timeout: 5000})
          
          const data = JSON.parse(stdout)
          const svc = data.services?.[0]

          if (svc) {
            const statusColor = svc.status === 'ACTIVE' ? 'green' : 'red'
            this.serviceCard!.setContent(`{center}{${statusColor}-fg}●{/${statusColor}-fg} ${svc.status}\n{gray-fg}${service}{/gray-fg}{/center}`)
            this.tasksCard!.setContent(`{center}{green-fg}${svc.runningCount || 0}{/green-fg} Running\n{gray-fg}${svc.desiredCount || 0} Desired{/gray-fg}{/center}`)

            // Mock CPU/Memory data (in real implementation, get from CloudWatch)
            const cpuPercent = Math.random() * 100
            const memoryPercent = Math.random() * 100
            this.cpuCard!.setContent(`{center}{white-fg}${cpuPercent.toFixed(1)}%\nAllocated{/white-fg}{/center}`)
            this.memoryCard!.setContent(`{center}{white-fg}${memoryPercent.toFixed(1)}%\nAllocated{/white-fg}{/center}`)

            // Update tasks table (mock data)
            const tableData = [
              ['Task ID', 'Status', 'Health', 'CPU', 'Memory', 'Created']
            ]
            
            for (let i = 0; i < Math.min(svc.runningCount || 0, 5); i++) {
              tableData.push([
                `task-${Math.random().toString(36).substr(2, 8)}`,
                'RUNNING',
                'HEALTHY',
                '256',
                '512MB',
                new Date().toLocaleTimeString()
              ])
            }
            
            this.tasksTable.setData({
              headers: tableData[0],
              data: tableData.slice(1)
            })
          } else {
            this.serviceCard!.setContent(`{center}{red-fg}●{/red-fg} Not Found\n{gray-fg}${service}{/gray-fg}{/center}`)
            this.tasksCard!.setContent(`{center}{yellow-fg}0{/yellow-fg} Running\n{gray-fg}Deploy needed{/gray-fg}{/center}`)
            this.cpuCard!.setContent(`{center}{white-fg}N/A\nNo service{/white-fg}{/center}`)
            this.memoryCard!.setContent(`{center}{white-fg}N/A\nNo service{/white-fg}{/center}`)
          }
        } catch {
          this.serviceCard!.setContent(`{center}{yellow-fg}●{/yellow-fg} Unknown\n{gray-fg}Check AWS CLI{/gray-fg}{/center}`)
          this.tasksCard!.setContent(`{center}{yellow-fg}?{/yellow-fg} Running\n{gray-fg}AWS Error{/gray-fg}{/center}`)
          this.cpuCard!.setContent(`{center}{white-fg}N/A\nAWS Error{/white-fg}{/center}`)
          this.memoryCard!.setContent(`{center}{white-fg}N/A\nAWS Error{/white-fg}{/center}`)
        }

        updateSystemInfo()
        statusText.setContent(`Last Updated: ${new Date().toLocaleTimeString()}`)
        screen.render()
      } catch (error: any) {
        this.serviceCard!.setContent(`{center}{red-fg}●{/red-fg} Error\n{gray-fg}${error.message.slice(0, 20)}{/gray-fg}{/center}`)
        screen.render()
      }
    }

    // Event handlers
    screen.key(['r'], refreshMetrics)

    // Initial setup
    updateSystemInfo()
    await refreshMetrics()
    
    // Auto-refresh every 30 seconds
    this.refreshInterval = setInterval(refreshMetrics, 30000)

    screen.render()
  }

  cleanup(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }
  }
}
