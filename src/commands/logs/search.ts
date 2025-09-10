import {Command, Flags} from '@oclif/core'
import mysql from '../../lib/mysql-shim.js'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'
import {CloudWatchLogsClient, DescribeLogGroupsCommand} from '@aws-sdk/client-cloudwatch-logs'
import {spawn} from 'node:child_process'
import {getTiDBProfile, parseMySqlDsn} from '../../lib/config.js'
import blessed from 'blessed'
import contrib from 'blessed-contrib'
import inquirer from 'inquirer'
import {ToolManager} from '../../lib/tools/index.js'
import {LlmClient, LlmMessage} from '../../lib/llm/client.js'
import clipboard from 'clipboardy'
import {randomUUID} from 'node:crypto'
import {markdownToBlessed} from '../../lib/markdown.js'

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
      width: '60%',
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
      left: '62%',
      width: '36%',
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
      width: '60%',
      height: '60%',
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
      top: '70%',
      left: 2,
      width: '60%',
      height: '28%',
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

    // Tail logs panel (right-bottom)
    const tailLogsBox = blessed.box({
      parent: container,
      label: ' Ingestion Logs ',
      top: '70%',
      left: '62%',
      width: '36%',
      height: '28%',
      border: {type: 'line'},
      style: {fg: 'white', bg: 'black', border: {fg: 'blue'}},
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      tags: false,
      content: 'No background tail running yet.'
    })

    // Charts: sparkline for ingestion rate and bar for errors
    const chartsBox = blessed.box({
      parent: tailLogsBox,
      top: 1,
      left: 1,
      width: '100%-2',
      height: 7,
      style: {fg: 'white', bg: 'black'}
    })
    const spark = contrib.sparkline({
      label: 'Ingested rows/min',
      tags: true,
      style: {fg: 'green'}
    }) as unknown as blessed.Widgets.BoxElement
    chartsBox.append(spark as any)
    const errorsBox = blessed.box({
      parent: tailLogsBox,
      top: 8,
      left: 1,
      width: '100%-2',
      height: 3,
      content: '{red-fg}Errors (last 5):{/red-fg}',
      tags: true,
      style: {fg: 'white', bg: 'black'}
    })

    // Chat panel (container)
    const chatPanel = blessed.box({
      parent: container,
      label: ' LLM Chat ',
      top: 8,
      left: '62%',
      width: '36%',
      height: '60%',
      border: {type: 'line'},
      style: {fg: 'white', bg: 'black', border: {fg: 'magenta'}},
      tags: true
    })

    // Chat transcript inside panel
    const chatTranscript = blessed.box({
      parent: chatPanel,
      top: 1,
      left: 1,
      width: '100%-2',
      height: '100%-5',
      style: {fg: 'white', bg: 'black'},
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      tags: true,
      content: '{gray-fg}Press c to focus chat. Type a question and Enter.{/gray-fg}'
    })

    // Chat input inside panel
    const chatInput = blessed.textbox({
      parent: chatPanel,
      label: ' Chat ',
      top: '100%-5',
      left: 1,
      width: '100%-3',
      height: 3,
      border: {type: 'line'},
      style: {fg: 'white', bg: 'black', border: {fg: 'magenta'}, focus: {border: {fg: 'yellow'}}},
      inputOnFocus: true
    })

    // Instructions
    const instructions = blessed.text({
      parent: container,
      bottom: 0,
      height: 1,
      width: '100%',
      content: '{center}TAB to navigate • s or / to search • c to chat • t to focus tail • Enter to submit • a to ask about selected result • q to quit{/center}',
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
        lastResultsCache = results
        
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
        const msg = e?.message || String(e)
        statusBox.setContent(`ERROR: ${msg}`)
        lastErrors.push({ts: Date.now(), msg: `[search] ${msg}`})
      }
      
      screen.render()
    }

    // LLM chat setup
    const tools = new ToolManager()
    const llm = new LlmClient(tools)
    await llm.ensureConfigured()
    const conversation: LlmMessage[] = [
      {role: 'system', content: llm.buildSystemPrompt()}
    ]

    const appendChat = (prefix: string, text: string) => {
      const old = chatTranscript.getContent() || ''
      const rendered = markdownToBlessed(text)
      // For streaming tokens (prefix === ''), append inline to current line without forcing a new line.
      const next = `${old}${prefix ? (old ? '\n' : '') + prefix : ''}${rendered}`
      chatTranscript.setContent(next)
      chatTranscript.setScrollPerc(100)
      screen.render()
    }

    const sendChat = async (input: string) => {
      if (!input.trim()) return
      appendChat('{cyan-fg}You:{/cyan-fg} ', input)
      conversation.push({role: 'user', content: input})
      // Intercept analysis tool calls for approval
      const originalExecute = (tools as any).executeTool.bind(tools)
      ;(tools as any).executeTool = async (toolCall: any) => {
        if (toolCall.name === 'analysis') {
          const {approve} = await inquirer.prompt([{type: 'confirm', name: 'approve', default: false, message: `Unsafe analysis tool call with args ${JSON.stringify(toolCall.arguments)}. Approve?`}])
          if (!approve) return 'User rejected analysis tool call.'
        }
        return originalExecute(toolCall)
      }
      let didStream = false
      const {final} = await llm.handleToolCycle(conversation, {temperature: 0.6, maxTokens: 500, stream: true}, {
        onToolStart: (call) => appendChat('{yellow-fg}Tool start:{/yellow-fg} ', `${call.name} ${JSON.stringify(call.arguments)}`),
        onToolResult: (call, result) => appendChat('{green-fg}Tool result:{/green-fg} ', `${call.name}: ${result}`),
        onToolError: (call, err) => appendChat('{red-fg}Tool error:{/red-fg} ', `${call.name}: ${err}`)
        ,
        onStreamStart: () => { didStream = true; appendChat('{gray-fg}Assistant:{/gray-fg} ', '') },
        onStreamToken: (t) => appendChat('', t),
        onStreamEnd: () => {}
      })
      if (!didStream) {
        appendChat('{green-fg}Assistant:{/green-fg} ', final)
      }
    }

    // Background tail setup
    const sanitizeAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '')
    let tailChild: ReturnType<typeof spawn> | null = null
    let tailBuffer: string[] = []
    let lastErrors: Array<{ts: number; msg: string}> = []
    let lastResultsCache: Array<SearchResult & {distance: number}> = []
    const sessionId = randomUUID()
    const ingestBatches: Array<{ts: number; count: number}> = []
    const appendTail = (line: string) => {
      const clean = sanitizeAnsi(line).trimEnd()
      if (!clean) return
      tailBuffer.push(clean)
      if (tailBuffer.length > 400) tailBuffer.splice(0, tailBuffer.length - 400)
      tailLogsBox.setContent(tailBuffer.join('\n'))
      tailLogsBox.setScrollPerc(100)
      screen.render()
    }

    // Update charts periodically
    setInterval(() => {
      // Ingestion sparkline: compute rows per minute from tailBuffer heuristics
      const now = Date.now()
      const windowMs = 5 * 60 * 1000
      const buckets = new Array(5).fill(0)
      for (const e of ingestBatches) {
        if (now - e.ts > windowMs) continue
        const idx = Math.min(4, Math.floor((now - e.ts) / (60 * 1000)))
        buckets[4 - idx] += e.count
      }
      ;(spark as any).setData(['Ingest'], [buckets.map((v: number) => Number(v))])
      // Errors summary
      const last5 = lastErrors.slice(-5).map(e => e.msg)
      errorsBox.setContent('{red-fg}Errors (last 5):{/red-fg}\n' + (last5.join('\n') || 'None'))
      screen.render()
    }, 3000)

    const startTail = async (group: string) => {
      if (!group) {
        appendTail('Skipping background tail. Press g to choose a log group later.')
        return
      }
      const args = ['logs', 'tail', group]
      // propagate flags
      if (flags.region) args.unshift('--region', flags.region)
      args.push('--follow')
      args.push('--format', 'detailed')
      // Run via AWS CLI directly, but we want embedding and storage—use our tail command instead
      const cmd = process.execPath
      const runArgs = ['./bin/run.js', 'logs', 'tail', group,
        ...(flags['sagemaker-endpoint'] ? ['--sagemaker-endpoint', flags['sagemaker-endpoint']] : []),
        ...(flags['sagemaker-region'] ? ['--sagemaker-region', flags['sagemaker-region']] : []),
        ...(flags.region ? ['--region', flags.region] : []),
      ]
      appendTail(`Starting tail: node ${runArgs.join(' ')}`)
      tailChild = spawn(cmd, runArgs)
      tailChild.stdout?.on('data', (d) => {
        const str = d.toString()
        for (const line of str.split('\n')) appendTail(line)
      })
      tailChild.stderr?.on('data', (d) => {
        const str = d.toString()
        for (const line of str.split('\n')) {
          appendTail(line)
          if (/error/i.test(line)) lastErrors.push({ts: Date.now(), msg: line})
        }
      })
      tailChild.on('close', (code) => {
        appendTail(`Tail process exited with code ${code}`)
      })
    }

    // CloudWatch log group picker (TUI modal)
    const openTailPicker = async () => {
      const overlay = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: '70%',
        label: ' Select CloudWatch Log Group ',
        border: {type: 'line'},
        style: {fg: 'white', bg: 'black', border: {fg: 'blue'}},
        keys: true,
        mouse: true,
        tags: true
      })
      const filter = blessed.textbox({
        parent: overlay,
        label: ' Filter ',
        top: 1,
        left: 1,
        width: '100%-2',
        height: 3,
        border: {type: 'line'},
        inputOnFocus: true,
        keys: true,
        style: {fg: 'white', bg: 'black', border: {fg: 'blue'}, focus: {border: {fg: 'yellow'}}}
      })
      const list = blessed.list({
        parent: overlay,
        top: 5,
        left: 1,
        width: '100%-2',
        height: '100%-6',
        border: {type: 'line'},
        keys: true,
        vi: true,
        mouse: true,
        style: {fg: 'white', bg: 'black', selected: {bg: 'blue', fg: 'white'}, border: {fg: 'blue'}}
      })

      const cwClient = new CloudWatchLogsClient({region: flags.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION})
      const allGroups: string[] = []
      try {
        let nextToken: string | undefined = undefined
        while (true) {
          const respRes: any = await cwClient.send(new DescribeLogGroupsCommand({nextToken}))
          const names = (respRes.logGroups || []).map((g: any) => g.logGroupName as string).filter(Boolean)
          allGroups.push(...names)
          nextToken = respRes.nextToken as string | undefined
          if (!nextToken) break
        }
      } catch (e: any) {
        // Fallback info
        allGroups.push('/aws/lambda/your-func', '/aws/ecs/your-service')
      }

      const applyFilter = (q: string) => {
        const ql = q.toLowerCase().trim()
        const items = allGroups.filter(n => !ql || n.toLowerCase().includes(ql))
        list.setItems(items.length ? items : ['<no matches>'])
        list.select(0)
        screen.render()
      }
      applyFilter('')

      // Keyboard bindings for filter
      filter.key(['escape'], () => { overlay.destroy(); screen.render() })
      filter.key(['down', 'tab'], () => { list.focus(); screen.render() })
      filter.on('keypress', () => {
        // Defer read of textbox value so it includes the latest character
        setTimeout(() => {
          const val = (filter as any).getValue ? (filter as any).getValue() : (filter as any).value || ''
          applyFilter(String(val))
        }, 0)
      })

      // Keyboard bindings for list
      list.key(['escape'], () => { overlay.destroy(); screen.render() })
      list.key(['up'], () => {
        if ((list as any).selected === 0) { filter.focus(); screen.render() }
      })
      list.key(['enter'], async () => {
        const idx = (list as any).selected || 0
        const items = (list as any).items || []
        const item = items[idx]
        const name = item?.getText ? item.getText() : String(item?.content || '')
        if (!name || name === '<no matches>') return
        overlay.destroy()
        screen.render()
        await startTail(name)
      })

      // Focus filter after render tick to ensure overlay is ready
      setTimeout(() => { filter.focus(); screen.render() }, 0)
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

    chatInput.on('submit', async (q) => {
      await sendChat(q)
      chatInput.clearValue()
      chatInput.focus()
    })

    // Navigation
    screen.key(['tab'], () => {
      if (screen.focused === searchBox) {
        resultsList.focus()
      } else if (screen.focused === resultsList) {
        chatInput.focus()
      } else {
        searchBox.focus()
      }
    })

    screen.key(['s', '/'], () => {
      searchBox.focus()
    })

    screen.key(['c'], () => {
      chatInput.focus()
    })

    screen.key(['t'], () => {
      tailLogsBox.focus()
    })

    // Open tail picker
    screen.key(['g'], () => {
      openTailPicker().catch(() => {})
    })

    // Ask about selected result
    screen.key(['a'], () => {
      const results = (resultsList as any).searchResults
      const idx = (resultsList as any).selected || 0
      if (results && results[idx]) {
        const r = results[idx]
        const text = `Please analyze this log entry and potential root cause. Score=${(1 - r.distance).toFixed(3)}, ts=${new Date(r.ts_ms).toISOString()}, group=${r.log_group}, stream=${r.log_stream}. Message: ${r.message}`
        chatInput.setValue(text)
        chatInput.focus()
        screen.render()
      }
    })

    screen.key(['q', 'C-c'], () => {
      pool.end()
      process.exit(0)
    })

    // Initial focus and render
    searchBox.focus()
    screen.render()
    // Start background tail picker on startup
    openTailPicker().catch(() => {})

    // Diagnostics copy (key: d)
    screen.key(['d'], async () => {
      const requestId = randomUUID()
      const diag = {
        sessionId,
        requestId,
        timestamp: new Date().toISOString(),
        search: {
          table: flags.table,
          lastResultsCount: lastResultsCache.length,
          results: lastResultsCache.slice(0, 50)
        },
        tail: {
          lastLines: tailBuffer.slice(-200)
        },
        llm: {
          provider: llm.getProviderLabel(),
          conversation
        },
        errors: lastErrors.slice(-100)
      }
      const text = `AutoIR Diagnostics\nSession: ${sessionId}\nRequest: ${requestId}\nTime: ${new Date().toISOString()}\n\n${JSON.stringify(diag, null, 2)}`
      await clipboard.write(text)
      statusBox.setContent('Diagnostics copied to clipboard')
      screen.render()
    })
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
    pool: any,
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
