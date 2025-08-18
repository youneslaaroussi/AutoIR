import {Command, Flags} from '@oclif/core'
import mysql from 'mysql2/promise'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'
import {getTiDBProfile, parseMySqlDsn} from '../../lib/config.js'
import blessed from 'blessed'
import inquirer from 'inquirer'

type SearchResult = {
  id: string
  log_group: string
  log_stream: string
  ts_ms: number
  message: string
  score: number
}

export default class LogsSearch extends Command {
  static description = 'Interactive semantic search over ingested logs with a fancy CLI interface'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
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
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(LogsSearch)

    // Connect to TiDB
    const conn = await this.resolveTiDBConn(flags)
    const pool = mysql.createPool({
      host: conn.host,
      port: conn.port ?? 4000,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      waitForConnections: true,
      connectionLimit: 5,
      ...( /tidbcloud\.com$/i.test(conn.host) ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}} : {}),
    })

    // Create blessed screen
    const screen = blessed.screen({
      smartCSR: true,
      title: 'AutoIR - Semantic Log Search'
    })

    // Create main container
    const container = blessed.box({
      parent: screen,
      width: '100%',
      height: '100%',
      style: {
        bg: 'black'
      }
    })

    // Title
    const title = blessed.text({
      parent: container,
      content: '{center}{bold}AutoIR Semantic Log Search{/bold}{/center}',
      top: 0,
      height: 3,
      width: '100%',
      tags: true,
      style: {
        fg: 'cyan',
        bg: 'black'
      }
    })

    // Search input
    const searchBox = blessed.textbox({
      parent: container,
      label: ' Search Query ',
      top: 4,
      left: 2,
      width: '50%',
      height: 3,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan'
        },
        focus: {
          border: {
            fg: 'yellow'
          }
        }
      },
      inputOnFocus: true
    })

    // Status box
    const statusBox = blessed.box({
      parent: container,
      label: ' Status ',
      top: 4,
      left: '52%',
      width: '46%',
      height: 3,
      border: {
        type: 'line'
      },
      style: {
        fg: 'green',
        bg: 'black',
        border: {
          fg: 'cyan'
        }
      },
      content: 'Ready to search...'
    })

    // Results list
    const resultsList = blessed.list({
      parent: container,
      label: ' Search Results ',
      top: 8,
      left: 2,
      width: '96%',
      height: '70%',
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan'
        },
        selected: {
          bg: 'blue',
          fg: 'white'
        }
      },
      keys: true,
      vi: true,
      scrollable: true,
      items: ['No results yet. Enter a search query above and press Enter.']
    })

    // Result detail
    const detailBox = blessed.box({
      parent: container,
      label: ' Message Detail ',
      top: '80%',
      left: 2,
      width: '96%',
      height: '18%',
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan'
        }
      },
      scrollable: true,
      content: 'Select a result to view details...'
    })

    // Instructions
    const instructions = blessed.text({
      parent: container,
      bottom: 0,
      height: 1,
      width: '100%',
      content: '{center}TAB to navigate • s or / to search • Enter to search • q to quit • ↑↓ to browse results{/center}',
      tags: true,
      style: {
        fg: 'yellow',
        bg: 'black'
      }
    })

    // Search function
    const performSearch = async (query: string) => {
      if (!query.trim()) return

      statusBox.setContent('Searching...')
      screen.render()

      try {
        // Embed the query
        const qVec = await this.embedQuerySageMaker(query, flags['sagemaker-endpoint']!, flags['sagemaker-region'] || flags.region)
        if (!qVec.length) {
          statusBox.setContent('ERROR: Failed to generate embedding')
          screen.render()
          return
        }

        // Search
        const results = await this.searchByVector(pool, flags.table!, qVec, undefined, undefined, 20, 10)
        
        statusBox.setContent(`Found ${results.length} results`)
        
        if (results.length === 0) {
          resultsList.setItems(['No results found for this query.'])
          detailBox.setContent('No results to display.')
        } else {
          const items = results.map((r, i) => {
            const score = (1 - r.distance).toFixed(3)
            const time = new Date(r.ts_ms).toLocaleTimeString()
            const preview = r.message.slice(0, 80) + (r.message.length > 80 ? '...' : '')
            return `${i + 1}. [${score}] ${time} - ${preview}`
          })
          
          resultsList.setItems(items)
          resultsList.select(0)
          
          // Store results for detail view
          ;(resultsList as any).searchResults = results
        }
      } catch (e: any) {
        statusBox.setContent(`ERROR: ${e.message}`)
      }
      
      screen.render()
    }

    // Event handlers
    searchBox.on('submit', async (query) => {
      await performSearch(query)
      resultsList.focus()
    })

    resultsList.on('select', (item, index) => {
      const results = (resultsList as any).searchResults
      if (results && results[index]) {
        const result = results[index]
        const score = (1 - result.distance).toFixed(6)
        const time = new Date(result.ts_ms).toISOString()
        const content = `Score: ${score} | Time: ${time} | Group: ${result.log_group}
Stream: ${result.log_stream}

Message:
${result.message}`
        detailBox.setContent(content)
        screen.render()
      }
    })

    // Navigation
    screen.key(['tab'], () => {
      if (screen.focused === searchBox) {
        resultsList.focus()
      } else {
        searchBox.focus()
      }
    })

    screen.key(['s', '/'], () => {
      searchBox.focus()
    })

    screen.key(['q', 'C-c'], () => {
      pool.end()
      process.exit(0)
    })

    // Initial focus and render
    searchBox.focus()
    screen.render()
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

  private async searchByVector(
    pool: mysql.Pool,
    table: string,
    qVec: number[],
    group: string | undefined,
    since: string | undefined,
    limit: number,
    minLen: number,
  ): Promise<Array<SearchResult & {distance: number}>> {
    const where: string[] = ['CHAR_LENGTH(message) >= ?']
    const params: any[] = [JSON.stringify(qVec), minLen]
    if (group) { where.push('log_group = ?'); params.push(group) }
    if (since) {
      const cutoff = this.parseSince(since)
      if (cutoff) { where.push('ts_ms >= ?'); params.push(cutoff) }
    }
    const sql = `
      SELECT id, log_group, log_stream, ts_ms, message,
             vec_cosine_distance(embedding, CAST(? AS VECTOR(384))) AS distance
      FROM \`${table}\`
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY distance ASC
      LIMIT ?
    `
    params.push(limit)
    const [rows] = await pool.query(sql, params)
    return rows as Array<SearchResult & {distance: number}>
  }

  private parseSince(s: string): number | undefined {
    const now = Date.now()
    const m = /^([0-9]+)\s*(m|h|d)$/i.exec(s.trim())
    if (!m) return undefined
    const n = parseInt(m[1], 10)
    const unit = m[2].toLowerCase()
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
    return now - ms
  }

  private async embedQuerySageMaker(text: string, endpointName: string, region?: string): Promise<number[]> {
    const client = new SageMakerRuntimeClient({region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION})
    const body = JSON.stringify({inputs: text})
    const cmd = new InvokeEndpointCommand({
      EndpointName: endpointName,
      ContentType: 'application/json',
      Accept: 'application/json',
      Body: Buffer.from(body),
    })
    const resp = await client.send(cmd)
    const payloadStr = new TextDecoder().decode(resp.Body as any)
    const payload = JSON.parse(payloadStr)
    
    // Structure: [batch][tokens][384_dims] for single query
    const tokens = payload[0] as number[][]
    const dims = tokens[0]?.length || 0
    if (!dims) return []
    const sums = new Array(dims).fill(0)
    for (const token of tokens) {
      for (let i = 0; i < dims; i++) {
        sums[i] += token[i]
      }
    }
    return sums.map(v => v / tokens.length)
  }
}
