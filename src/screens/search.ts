import blessed from 'blessed'
import contrib from 'blessed-contrib'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'
import mysql from 'mysql2/promise'
import {Screen, ScreenContext} from '../lib/screen-manager.js'

export class SearchScreen implements Screen {
  name = 'Search'
  key = 's'
  description = 'Semantic log search'

  private searchInput?: blessed.Widgets.TextboxElement
  private resultsTable?: any
  private statusText?: blessed.Widgets.TextElement

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
      content: '{bold}{cyan-fg}AutoIR{/cyan-fg}{/bold} — Semantic Log Search',
      tags: true,
      style: { fg: 'white' }
    })

    this.statusText = blessed.text({
      parent: header,
      top: 1,
      left: 2,
      content: `Database: ${context.dbPool ? 'Connected' : 'Not connected'} • Endpoint: ${context.smEndpoint ? 'Ready' : 'Not configured'}`,
      style: { fg: context.dbPool && context.smEndpoint ? 'green' : 'yellow' }
    })

    // Search input
    this.searchInput = blessed.textbox({
      parent: container,
      top: 4,
      left: 1,
      width: '100%-2',
      height: 3,
      border: { type: 'line' },
      label: ' Search Query ',
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' },
        focus: { border: { fg: 'yellow' } }
      },
      tags: true
    })

    // Results table
    this.resultsTable = contrib.table({
      parent: container,
      top: 8,
      left: 1,
      width: '100%-2',
      height: '100%-11',
      label: ' Search Results ',
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
      content: '{center}{yellow-fg}Enter{/yellow-fg}: search • {yellow-fg}Escape{/yellow-fg}: menu • {yellow-fg}q{/yellow-fg}: quit{/center}',
      tags: true,
      style: { fg: 'white', bg: 'black' }
    })

    // Event handlers
    this.searchInput.key('enter', async () => {
      const query = this.searchInput!.getValue()
      if (query && query.trim()) {
        await this.runSearch(query.trim(), context)
        this.searchInput!.clearValue()
      }
      this.searchInput!.focus()
    })

    // Initial state
    this.resultsTable.setData({
      headers: ['Timestamp', 'Group', 'Stream', 'Message'],
      data: [['Welcome!', '', '', 'Enter a search query above and press Enter']]
    })

    this.searchInput.focus()
    screen.render()
  }

  private async runSearch(query: string, context: ScreenContext): Promise<void> {
    if (!this.resultsTable || !this.statusText) return

    // Show loading
    this.resultsTable.setData({
      headers: ['Timestamp', 'Group', 'Stream', 'Message'],
      data: [['Loading...', '', '', 'Searching logs...']]
    })
    this.resultsTable.screen.render()

    if (!context.dbPool) {
      this.resultsTable.setData({
        headers: ['Timestamp', 'Group', 'Stream', 'Message'],
        data: [['Error', '', '', 'Database not connected']]
      })
      this.resultsTable.screen.render()
      return
    }

    if (!context.smEndpoint || !context.smRegion) {
      this.resultsTable.setData({
        headers: ['Timestamp', 'Group', 'Stream', 'Message'],
        data: [['Error', '', '', 'SageMaker endpoint not configured']]
      })
      this.resultsTable.screen.render()
      return
    }

    try {
      const vec = await this.embedQuery(query, context.smEndpoint, context.smRegion)
      const results = await this.searchByVector(
        context.dbPool, 
        context.flags.table || 'autoir_log_events', 
        vec, 
        undefined, 
        undefined, 
        20, 
        32
      )
      
      const rows = results.map((r: any) => [
        new Date(r.ts_ms).toLocaleString(),
        String(r.log_group || '').slice(0, 19),
        String(r.log_stream || '').slice(0, 19),
        String(r.message || '').slice(0, 59)
      ])

      this.resultsTable.setData({
        headers: ['Timestamp', 'Group', 'Stream', 'Message'],
        data: rows.length > 0 ? rows : [['No results', '', '', 'Try a different search query']]
      })
      
      this.statusText.setContent(`Database: Connected • Endpoint: Ready • Last Search: ${new Date().toLocaleTimeString()} • Found ${results.length} results`)
      this.resultsTable.screen.render()
    } catch (error: any) {
      this.resultsTable.setData({
        headers: ['Timestamp', 'Group', 'Stream', 'Message'],
        data: [['Error', '', '', error.message || 'Search failed']]
      })
      this.resultsTable.screen.render()
    }
  }

  private async embedQuery(query: string, endpoint: string, region?: string): Promise<number[]> {
    const client = new SageMakerRuntimeClient({region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION})
    const payload = {inputs: query}
    const cmd = new InvokeEndpointCommand({
      EndpointName: endpoint,
      Body: new TextEncoder().encode(JSON.stringify(payload)),
      ContentType: 'application/json',
      Accept: 'application/json',
    })
    const resp = await client.send(cmd)
    const body = Buffer.from(resp.Body as Uint8Array).toString('utf8')
    const data = JSON.parse(body)
    const vec: number[] = Array.isArray(data) ? (Array.isArray(data[0]) ? data[0][0] : data) : (Array.isArray(data.embeddings) ? data.embeddings : [])
    if (!Array.isArray(vec) || vec.length === 0) throw new Error('Embedding endpoint returned no vector')
    return vec.map((v: any) => Number(v))
  }

  private async searchByVector(
    pool: mysql.Pool,
    table: string,
    qVec: number[],
    group: string | undefined,
    since: string | undefined,
    limit: number,
    minLen: number,
  ): Promise<Array<{id: string; log_group: string; log_stream: string; ts_ms: number; message: string; distance: number}>> {
    const where: string[] = ['CHAR_LENGTH(message) >= ?']
    const params: any[] = [minLen]
    if (group) { where.push('log_group = ?'); params.push(group) }
    if (since) {
      const ms = this.parseSince(since)
      if (ms) { where.push('ts_ms >= ?'); params.push(ms) }
    }
    const sql = `SELECT id, log_group, log_stream, ts_ms, message,
      1 - (embedding <=> CAST(? AS VECTOR(384))) AS score,
      (embedding <=> CAST(? AS VECTOR(384))) AS distance
      FROM \`${table}\`
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY distance ASC
      LIMIT ?`
    const [rows] = await pool.query(sql, [JSON.stringify(qVec), JSON.stringify(qVec), ...params, limit])
    return rows as any
  }

  private parseSince(expr: string): number | undefined {
    const m = /^([0-9]+)([smhd])$/.exec(String(expr||''))
    if (!m) return undefined
    const n = Number(m[1])
    const unit = m[2]
    const ms = unit === 's' ? n*1000 : unit === 'm' ? n*60_000 : unit === 'h' ? n*3_600_000 : n*86_400_000
    return Date.now() - ms
  }

  cleanup(): void {
    // No cleanup needed for this screen
  }
}
