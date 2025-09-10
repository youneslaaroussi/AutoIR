import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'node:child_process'
import {setTimeout as wait} from 'node:timers/promises'
import mysql from '../../lib/mysql-shim.js'
import {randomUUID} from 'node:crypto'
import {getTiDBProfile, parseMySqlDsn, setTiDBProfile} from '../../lib/config.js'
import enquirer from 'enquirer'
import chalk from 'chalk'
import ora from 'ora'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'

type LogEvent = {
  logGroupName: string
  logStreamName: string
  timestamp: number
  message: string
}

export default class LogsTail extends Command {
  static args = {
    group: Args.string({description: 'CloudWatch Logs group name', required: true}),
  }

  static description = 'Tail CloudWatch logs for a group, embed, and store into TiDB for vector search later'

  static examples = [
    '<%= config.bin %> <%= command.id %> /aws/lambda/my-func',
    '<%= config.bin %> <%= command.id %> /aws/lambda/my-func --no-embed',
  ]

  static flags = {
    profile: Flags.string({char: 'p', description: 'AWS profile to use'}),
    region: Flags.string({char: 'r', description: 'AWS region'}),
    'start-time': Flags.string({description: 'RFC3339 or relative like 15m'}),
    follow: Flags.boolean({description: 'Follow new log events', default: true}),
    embed: Flags.boolean({description: 'Generate embeddings with a SageMaker endpoint and store into TiDB VECTOR(384)', default: true}),
    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint name to use for embeddings'}),
    'sagemaker-region': Flags.string({description: 'AWS region for SageMaker endpoint'}),
    debug: Flags.boolean({description: 'Verbose debug logging of lines, events, embeddings, and inserts', default: false}),
    'batch-size': Flags.integer({description: 'Number of events to batch before insert', default: 2}),
    'flush-interval': Flags.integer({description: 'Flush interval milliseconds', default: 8000}),
    'tidb-host': Flags.string({description: 'TiDB host (or TiDB Cloud endpoint)', env: 'TIDB_HOST'}),
    'tidb-port': Flags.integer({description: 'TiDB port', env: 'TIDB_PORT', default: 4000}),
    'tidb-user': Flags.string({description: 'TiDB user', env: 'TIDB_USER'}),
    'tidb-password': Flags.string({description: 'TiDB password', env: 'TIDB_PASSWORD'}),
    'tidb-database': Flags.string({description: 'TiDB database', env: 'TIDB_DATABASE'}),
    'table': Flags.string({description: 'Destination table', default: 'autoir_log_events'}),
    'dry-run': Flags.boolean({description: 'Show what would be executed', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(LogsTail)
    const group = args.group

    const baseAwsArgs: string[] = ['logs', 'tail', group]
    if (flags.region) baseAwsArgs.unshift('--region', flags.region)
    const tailArgs = [
      ...baseAwsArgs,
      '--follow',
      '--format',
      'detailed',
    ]
    if (flags.profile) tailArgs.unshift('--profile', flags.profile)
    if (flags['start-time']) tailArgs.push('--since', flags['start-time'])

    if (flags['dry-run']) {
      this.log(chalk.cyan('[dry-run] ') + chalk.gray('aws ' + tailArgs.join(' ')))
      return
    }

    if (flags.embed && !flags['sagemaker-endpoint']) {
      this.error('Embeddings are required for VECTOR storage. Provide --sagemaker-endpoint and optionally --sagemaker-region.')
      return
    }

    // Connect TiDB: prefer saved profile, then DSN env, then flags
    const envDsn = process.env.TIDB_DSN
    const saved = await getTiDBProfile('default')
    const viaDsn = envDsn ? parseMySqlDsn(envDsn) : undefined
    let conn = saved ?? viaDsn ?? (
      (flags['tidb-host'] && flags['tidb-user'] && flags['tidb-database']) ? {
        host: flags['tidb-host'],
        port: flags['tidb-port'],
        user: flags['tidb-user'],
        password: flags['tidb-password'],
        database: flags['tidb-database'],
      } : undefined
    )

    if (!conn) {
      this.log('No TiDB connection found. Let\'s set it up once now (saved as default).')
      const {prompt} = enquirer as unknown as {prompt: <T>(q: any) => Promise<T>}
      const {useDsn} = await prompt<{useDsn: boolean}>({
        type: 'confirm',
        name: 'useDsn',
        message: 'Do you want to paste a MySQL DSN (mysql://user:pass@host:port/db)?',
        initial: true,
      })

      let newConn: {host: string; port?: number; user: string; password?: string; database: string} | undefined
      if (useDsn) {
        const {dsn} = await prompt<{dsn: string}>({
          type: 'input',
          name: 'dsn',
          message: 'MySQL DSN',
        })
        const parsed = parseMySqlDsn(dsn)
        if (!parsed) this.error('Invalid DSN format. Example: mysql://user:pass@host:4000/db')
        newConn = parsed
      } else {
        const ans = await prompt<{host: string; port: string; user: string; password: string; database: string}>([
          {type: 'input', name: 'host', message: 'TiDB host'},
          {type: 'input', name: 'port', message: 'TiDB port', initial: '4000'},
          {type: 'input', name: 'user', message: 'TiDB user'},
          {type: 'password', name: 'password', message: 'TiDB password (leave blank if none)'},
          {type: 'input', name: 'database', message: 'TiDB database'},
        ])
        newConn = {host: ans.host, port: Number(ans.port), user: ans.user, password: ans.password, database: ans.database}
      }

      await setTiDBProfile('default', newConn!, true)
      this.log('Saved TiDB default profile. Continuing...')
      conn = newConn
    }

    const connectSpinner = ora('Connecting to TiDB...').start()
    const pool = mysql.createPool({
      host: conn.host,
      port: conn.port ?? 4000,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      waitForConnections: true,
      connectionLimit: 5,
      // Enable TLS automatically for TiDB Cloud and secure DSNs
      ...( /tidbcloud\.com$/i.test(conn.host)
        ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}}
        : {}),
    })
    try {
      const c = await pool.getConnection()
      c.release()
      connectSpinner.succeed('Connected to TiDB')
    } catch (e: any) {
      connectSpinner.fail('Failed to connect to TiDB')
      this.error(e?.message || String(e))
      return
    }

    const tableSpinner = ora(`Ensuring table ${chalk.bold(flags.table)} exists...`).start()
    await this.ensureTable(pool, flags.table)
    tableSpinner.succeed(`Ready table ${chalk.bold(flags.table)}`)

    // Start tailing
    if (flags.debug) this.log(chalk.gray('[debug] aws ' + tailArgs.join(' ')))
    const startSpinner = ora('Starting CloudWatch tail...').start()
    const child = spawn('aws', tailArgs)
    child.stderr.on('data', (d) => this.log(d.toString()))
    startSpinner.succeed('Streaming logs')

    let buffer = ''
    const pending: LogEvent[] = []
    let lastFlush = Date.now()
    let received = 0
    let lastEventIso = ''

    const streamSpinner = ora({text: 'Streaming logs...', spinner: 'dots'}).start()
    const updateSpinner = () => {
      streamSpinner.text = `Streaming logs ${chalk.gray('(buffer ' + pending.length + ')')} — events: ${chalk.bold(received)}${lastEventIso ? chalk.gray(' • last ' + lastEventIso) : ''}`
    }

    const flushIfNeeded = async (force = false) => {
      const due = Date.now() - lastFlush >= (flags['flush-interval'] || 3000)
      if (!force && pending.length < (flags['batch-size'] || 50) && !due) return

      const batch = pending.splice(0, pending.length)
      if (batch.length === 0) return

      let embedDimForLog = 0
      try {
        const ansi = /\u001b\[[0-9;]*m/g
        const messages = batch.map(e => (e.message ?? '').toString().replace(ansi, ''))
        let embeddings: number[][] = []
        if (flags.embed) {
          embeddings = await this.embedBatchSageMaker(messages, flags['sagemaker-endpoint']!, flags['sagemaker-region'] || flags.region)
          
          // Debug: Check for failed embeddings
          if (flags.debug) {
            const failedCount = embeddings.filter(emb => !Array.isArray(emb) || emb.length === 0 || emb.every(x => x === 0 || x == null)).length
            if (failedCount > 0) {
              this.log(chalk.yellow(`[debug] ${failedCount}/${embeddings.length} embeddings failed or are empty`))
            }
          }
        }

        // Filter rows to store: only non-empty messages, and when embeddings enabled require non-empty vectors
        const indexesToKeep: number[] = []
        for (let i = 0; i < batch.length; i++) {
          const msgOk = messages[i].trim().length > 0
          const embOk = !flags.embed || (Array.isArray(embeddings[i]) && (embeddings[i] as number[]).length > 0 && !embeddings[i].every(x => x === 0 || x == null))
          if (msgOk && embOk) indexesToKeep.push(i)
        }

        embedDimForLog = flags.embed && indexesToKeep.length > 0 && Array.isArray(embeddings[indexesToKeep[0]])
          ? (embeddings[indexesToKeep[0]] as number[]).length
          : 0

        if (indexesToKeep.length === 0) {
          if (flags.debug) this.log(chalk.gray('[debug] skipping batch: nothing to store (empty messages and/or empty embeddings)'))
          return
        }

        const filteredEvents = indexesToKeep.map(i => batch[i])
        const filteredEmbeds = flags.embed ? indexesToKeep.map(i => embeddings[i] as number[]) : []

        await this.insertBatch(pool, flags.table, filteredEvents, filteredEmbeds)
        this.log(chalk.green(`Inserted ${filteredEvents.length} event(s) into ${flags.table}`))
      } catch (e: any) {
        const errCode = e?.code || e?.errno || e?.sqlState
        const errMsg = e?.sqlMessage || e?.message || String(e)
        const sample = batch[0]
        this.log(chalk.red('Failed to insert batch: ') + errMsg)
        if (errCode) this.log(chalk.red(`  Code: ${errCode}`))
        this.log(chalk.gray(`  Table: ${flags.table}; Batch size: ${batch.length}; Sample: {group: ${sample.logGroupName}, stream: ${sample.logStreamName}, ts: ${sample.timestamp}, msgLen: ${sample.message.length}, embedDims: ${embedDimForLog}}`))
        if (/Operation not allowed/i.test(errMsg)) {
          this.log(chalk.yellow('Hint: This may be due to a restricted table schema or permissions on TiDB Cloud Starter. We will try a more compatible schema (AUTO_INCREMENT).'))
        }
      } finally {
        lastFlush = Date.now()
        updateSpinner()
      }
    }

    let assembling: LogEvent | null = null
    const headerRe = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(\S+)\s(.*)$/
    const lineHandler = async (line: string) => {
      const trimmed = line.trimEnd()
      if (!trimmed) return
      const m = headerRe.exec(trimmed)
      if (m) {
        // New event header → flush previous
        if (assembling) {
          pending.push(assembling)
          received += 1
          lastEventIso = new Date(assembling.timestamp).toISOString()
          updateSpinner()
          await flushIfNeeded(false)
        }
        const [_, iso, stream, rest] = m
        assembling = {
          logGroupName: group,
          logStreamName: stream,
          timestamp: Date.parse(iso),
          message: rest ?? '',
        }
        if (flags.debug) this.log(chalk.gray('[debug] header → ') + JSON.stringify(assembling))
      } else {
        // Continuation line → append to current message
        if (assembling) {
          assembling.message += (assembling.message ? '\n' : '') + trimmed
          if (flags.debug) this.log(chalk.gray('[debug] append'))
        } else {
          if (flags.debug) this.log(chalk.gray('[debug] stray line (no header yet): ') + trimmed)
        }
      }
    }

    child.stdout.on('data', async (chunk) => {
      buffer += chunk.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        await lineHandler(line)
      }
    })

    const shutdown = async () => {
      await flushIfNeeded(true)
      await pool.end()
      streamSpinner.stop()
      this.log(chalk.yellow('Stopped streaming'))
    }

    child.on('close', async () => {
      // Flush the last assembling event
      if (assembling) {
        pending.push(assembling)
        assembling = null
      }
      await shutdown()
    })

    // Periodic flush safety
    ;(async () => {
      while (true) {
        await wait(flags['flush-interval'] || 3000)
        await flushIfNeeded(false)
      }
    })().catch(() => {})
  }

  private async ensureTable(pool: any, table: string) {
    // Create table if it does not exist with VECTOR(384)
    const createSql = `
      CREATE TABLE IF NOT EXISTS \`${table}\` (
        id VARCHAR(64) PRIMARY KEY,
        log_group VARCHAR(255),
        log_stream VARCHAR(255),
        ts_ms BIGINT,
        message TEXT,
        embedding VECTOR(384) NOT NULL COMMENT 'hnsw(distance=cosine)',
        KEY idx_group_ts (log_group, ts_ms)
      )
    `
    await pool.query(createSql)

    // Verify the column type is VECTOR; if not, stop with an explicit error
    const [rows] = await pool.query(
      `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'embedding'`,
      [table],
    )
    const dt = (rows[0]?.DATA_TYPE || rows[0]?.data_type || '').toString().toLowerCase()
    if (dt !== 'vector') {
      throw new Error(`Table ${table} exists but column 'embedding' is not VECTOR. Please migrate your schema (drop and recreate) to use VECTOR(384).`)
    }
  }

  private async insertBatch(
    pool: any,
    table: string,
    events: LogEvent[],
    embeddings: number[][],
  ) {
    const rows = events.map((e, i) => [
      randomUUID(),
      e.logGroupName,
      e.logStreamName,
      e.timestamp,
      e.message,
      JSON.stringify(embeddings[i] || []),
    ])
    const sqlSingle = `INSERT INTO \`${table}\` (id, log_group, log_stream, ts_ms, message, embedding) VALUES (?,?,?,?,?,CAST(? AS VECTOR(384)))`
    const conn = await pool.getConnection()
    try {
      for (const row of rows) {
        await conn.execute(sqlSingle, row)
      }
    } finally {
      conn.release()
    }
  }

  private async embedBatchSageMaker(texts: string[], endpointName: string, region?: string): Promise<number[][]> {
    if (!texts.length) return []
    const client = new SageMakerRuntimeClient({region: region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION})
    // Batch request: payload.inputs = string or string[]
    const sanitized = texts.map(t => t.length > 4000 ? t.slice(0, 4000) : t)
    const body = JSON.stringify({inputs: sanitized})
    try {
      const cmd = new InvokeEndpointCommand({
        EndpointName: endpointName,
        ContentType: 'application/json',
        Accept: 'application/json',
        Body: Buffer.from(body),
      })
      const resp = await client.send(cmd)
      const payloadStr = new TextDecoder().decode(resp.Body as any)
      const payload = JSON.parse(payloadStr)
      
      // Debug: Log the actual SageMaker response structure
      console.log(`[DEBUG] SageMaker response for ${sanitized.length} inputs:`, JSON.stringify(payload).slice(0, 500) + '...')
      if (Array.isArray(payload) && payload.length > 0) {
        console.log(`[DEBUG] First item structure: Array=${Array.isArray(payload[0])}, Length=${Array.isArray(payload[0]) ? (payload[0] as any[]).length : 'N/A'}`)
        if (Array.isArray(payload[0]) && payload[0].length > 0) {
          console.log(`[DEBUG] First item first element: Array=${Array.isArray(payload[0][0])}, Length=${Array.isArray(payload[0][0]) ? (payload[0][0] as any[]).length : 'N/A'}`)
        }
      }
      // Structure is: [batch][input][multiple_vectors][384_dims]
      // We need to average the multiple vectors for each input
      const out: number[][] = []
      for (const batchItem of payload as number[][][][]) {
        const vectors = batchItem[0] // Get the multiple vectors array
        if (!vectors || vectors.length === 0) {
          out.push([])
          continue
        }
        
        const dims = vectors[0].length // Should be 384
        const sums = new Array(dims).fill(0)
        for (const vector of vectors) {
          for (let i = 0; i < dims; i++) {
            sums[i] += vector[i]
          }
        }
        const avgVector = sums.map(v => v / vectors.length)
        console.log(`[DEBUG] Processed input: ${vectors.length} vectors × ${dims} dims → averaged to ${avgVector.length} dims`)
        out.push(avgVector)
      }
      return out
    } catch (e: any) {
      // On client error, skip embeddings this round
      console.error(`[embedBatchSageMaker] Failed to generate embeddings: ${e?.message || String(e)}`)
      if (e?.name) console.error(`[embedBatchSageMaker] Error type: ${e.name}`)
      if (e?.code) console.error(`[embedBatchSageMaker] Error code: ${e.code}`)
      return texts.map(() => [])
    }
  }
}



