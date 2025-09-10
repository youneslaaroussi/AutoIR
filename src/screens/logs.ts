import blessed from 'blessed'
import contrib from 'blessed-contrib'
import mysql from '../lib/mysql-shim.js'
import {Screen, ScreenContext} from '../lib/screen-manager.js'

export class LogsScreen implements Screen {
  name = 'Logs'
  key = 'l'
  description = 'Recent logs and live tail viewer'

  private logsTable?: any
  private filterInput?: blessed.Widgets.TextboxElement
  private statusText?: blessed.Widgets.TextElement
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
      content: '{bold}{cyan-fg}AutoIR{/cyan-fg}{/bold} — Recent Logs',
      tags: true,
      style: { fg: 'white' }
    })

    this.statusText = blessed.text({
      parent: header,
      top: 1,
      left: 2,
      content: `Database: ${context.dbPool ? 'Connected' : 'Not connected'} • Auto-refresh: ON`,
      style: { fg: context.dbPool ? 'green' : 'red' }
    })

    // Filter input
    this.filterInput = blessed.textbox({
      parent: container,
      top: 4,
      left: 1,
      width: '100%-2',
      height: 3,
      border: { type: 'line' },
      label: ' Filter (log group/stream) ',
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' },
        focus: { border: { fg: 'yellow' } }
      },
      tags: true
    })

    // Logs table
    this.logsTable = contrib.table({
      parent: container,
      top: 8,
      left: 1,
      width: '100%-2',
      height: '100%-11',
      label: ' Recent Logs (Latest 50) ',
      keys: true,
      vi: true,
      mouse: true,
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'green' },
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white' },
        selected: { fg: 'black', bg: 'cyan' }
      },
      columnSpacing: 1,
      columnWidth: [20, 20, 20, 60]
    })

    // Footer
    const footer = blessed.box({
      parent: container,
      bottom: 0,
      height: 1,
      width: '100%',
      content: '{center}{yellow-fg}Enter{/yellow-fg}: filter • {yellow-fg}r{/yellow-fg}: refresh • {yellow-fg}t{/yellow-fg}: toggle auto-refresh • {yellow-fg}Escape{/yellow-fg}: menu • {yellow-fg}q{/yellow-fg}: quit{/center}',
      tags: true,
      style: { fg: 'white', bg: 'black' }
    })

    // Load recent logs function
    const loadRecentLogs = async (filter?: string) => {
      if (!context.dbPool) {
        this.logsTable!.setData({
          headers: ['Timestamp', 'Group', 'Stream', 'Message'],
          data: [['Error', '', '', 'Database not connected']]
        })
        screen.render()
        return
      }

      try {
        const table = context.flags.table || 'autoir_log_events'
        let sql = `SELECT log_group, log_stream, ts_ms, message FROM \`${table}\``
        const params: any[] = []

        if (filter && filter.trim()) {
          sql += ` WHERE log_group LIKE ? OR log_stream LIKE ? OR message LIKE ?`
          const filterParam = `%${filter.trim()}%`
          params.push(filterParam, filterParam, filterParam)
        }

        sql += ` ORDER BY ts_ms DESC LIMIT 50`

        const [rows] = await context.dbPool.query(sql, params)
        const logs = rows as any[]

        const tableData = logs.map(log => [
          new Date(log.ts_ms).toLocaleString(),
          String(log.log_group || '').slice(0, 19),
          String(log.log_stream || '').slice(0, 19),
          String(log.message || '').slice(0, 59)
        ])

        this.logsTable!.setData({
          headers: ['Timestamp', 'Group', 'Stream', 'Message'],
          data: tableData.length > 0 ? tableData : [['No logs', '', '', 'No logs found matching criteria']]
        })

        this.statusText!.setContent(`Database: Connected • Loaded ${logs.length} logs • Last refresh: ${new Date().toLocaleTimeString()}`)
        screen.render()
      } catch (error: any) {
        this.logsTable!.setData({
          headers: ['Timestamp', 'Group', 'Stream', 'Message'],
          data: [['Error', '', '', error.message || 'Failed to load logs']]
        })
        screen.render()
      }
    }

    // Event handlers
    this.filterInput.key('enter', async () => {
      const filter = this.filterInput!.getValue()
      await loadRecentLogs(filter)
      this.filterInput!.focus()
    })

    let autoRefresh = true
    screen.key(['r'], async () => {
      const filter = this.filterInput!.getValue()
      await loadRecentLogs(filter)
    })

    screen.key(['t'], () => {
      autoRefresh = !autoRefresh
      if (autoRefresh) {
        this.refreshInterval = setInterval(async () => {
          const filter = this.filterInput!.getValue()
          await loadRecentLogs(filter)
        }, 5000)
        this.statusText!.setContent(this.statusText!.getContent().replace('Auto-refresh: OFF', 'Auto-refresh: ON'))
      } else {
        if (this.refreshInterval) {
          clearInterval(this.refreshInterval)
          this.refreshInterval = undefined
        }
        this.statusText!.setContent(this.statusText!.getContent().replace('Auto-refresh: ON', 'Auto-refresh: OFF'))
      }
      screen.render()
    })

    // Initial load
    this.logsTable.setData({
      headers: ['Timestamp', 'Group', 'Stream', 'Message'],
      data: [['Loading...', '', '', 'Loading recent logs...']]
    })

    await loadRecentLogs()

    // Auto-refresh every 5 seconds
    this.refreshInterval = setInterval(async () => {
      if (autoRefresh) {
        const filter = this.filterInput!.getValue()
        await loadRecentLogs(filter)
      }
    }, 5000)

    this.filterInput.focus()
    screen.render()
  }

  cleanup(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }
  }
}
