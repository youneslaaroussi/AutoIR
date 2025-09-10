import {Args, Command, Flags} from '@oclif/core'
import mysql from '../../lib/mysql-shim.js'
import chalk from 'chalk'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'
import {getTiDBProfile, parseMySqlDsn} from '../../lib/config.js'

type Row = {
  id: string
  log_group: string
  log_stream: string
  ts_ms: number
  message: string
}

export default class LogsQuery extends Command {
  static description = 'Semantic search over ingested logs using embeddings stored in TiDB'

  static examples = [
    '<%= config.bin %> <%= command.id %> "stripe error checkout" --region us-east-1 --sagemaker-endpoint autoir-embed-ep-srv --sagemaker-region us-east-1',
  ]

  static args = {
    query: Args.string({description: 'Free-text query to search for', required: true}),
  }

  static flags = {
    region: Flags.string({char: 'r', description: 'AWS region for CloudWatch (unused here, for symmetry)'}),
    profile: Flags.string({char: 'p', description: 'AWS profile (unused here, for symmetry)'}),

    table: Flags.string({description: 'TiDB table with logs', default: 'autoir_log_events'}),
    group: Flags.string({description: 'Filter by CloudWatch log group name'}),
    since: Flags.string({description: 'Time window for candidates (e.g., 1h, 24h, 7d)'}),
    limit: Flags.integer({description: 'Top results to return', default: 20}),
    'min-len': Flags.integer({description: 'Minimum message length to consider', default: 32}),

    dsn: Flags.string({description: 'MySQL DSN: mysql://user:pass@host:port/db', env: 'TIDB_DSN'}),
    'tidb-host': Flags.string({description: 'TiDB host (or endpoint)'}),
    'tidb-port': Flags.integer({description: 'TiDB port', default: 4000}),
    'tidb-user': Flags.string({description: 'TiDB user'}),
    'tidb-password': Flags.string({description: 'TiDB password'}),
    'tidb-database': Flags.string({description: 'TiDB database'}),

    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint for embeddings', required: true}),
    'sagemaker-region': Flags.string({description: 'AWS region for SageMaker endpoint'}),

    json: Flags.boolean({description: 'Output JSON', default: false}),
    debug: Flags.boolean({description: 'Verbose logs', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(LogsQuery)
    const queryText = args.query

    // Connect TiDB via DSN, saved profile, or flags
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

    // Embed the query via SageMaker
    const qVec = await this.embedQuerySageMaker(queryText, flags['sagemaker-endpoint']!, flags['sagemaker-region'] || flags.region)
    if (!qVec.length) {
      this.error('Failed to generate embedding for the query. Ensure the SageMaker endpoint is healthy and returns vectors.')
      return
    }

    // Server-side vector search using TiDB VECTOR and cosine distance
    const top = await this.searchByVector(
      pool,
      flags.table!,
      qVec,
      flags.group,
      flags.since,
      flags.limit!,
      flags['min-len']!,
    )

    if (flags.json) {
      this.log(JSON.stringify(top, null, 2))
    } else {
      for (const r of top) {
        const when = new Date(r.ts_ms).toISOString()
        const score = (1 - (r as any).distance)
        this.log(`${chalk.bold(score.toFixed(6))}  ${when}  ${chalk.gray(r.log_group)}  ${chalk.gray(r.log_stream)}\n${r.message}\n`)
      }
      if (top.length === 0) this.log(chalk.yellow('No results'))
    }

    await pool.end()
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
  ): Promise<Array<Row & {distance: number}>> {
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
    return rows as Array<Row & {distance: number}>
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

  // Removed client-side JSON embedding scoring; using TiDB VECTOR + vec_cosine_distance

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


