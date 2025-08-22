import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {getDatabase} from '../../lib/db-factory.js'
import {getMockSageMaker} from '../../lib/mock-aws.js'

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

    // Use database factory (will use mock for demo)
    const db = await getDatabase()
    
    // Use mock SageMaker for embeddings
    const sagemaker = await getMockSageMaker(flags['sagemaker-endpoint']!)
    
    if (flags.debug) {
      this.log(chalk.gray(`Using ${db.isUsingMockDatabase() ? 'mock' : 'real'} database for demo`))
    }

    // Generate embedding for the query
    const qVec = await sagemaker.invokeEndpoint(queryText)
    if (!qVec.length) {
      this.error('Failed to generate embedding for the query.')
      return
    }

    // Build vector search SQL
    const vectorSql = this.buildVectorSearchSql(flags.table!, qVec, flags.group, flags.since, flags.limit!, flags['min-len']!)
    
    // Execute search
    const results = await db.query(vectorSql)

    if (flags.json) {
      this.log(JSON.stringify(results, null, 2))
    } else {
      for (const r of results) {
        const when = new Date(r.ts_ms).toISOString()
        const score = (1 - (r.distance || 0))
        this.log(`${chalk.bold(score.toFixed(6))}  ${when}  ${chalk.gray(r.log_group)}  ${chalk.gray(r.log_stream)}\n${r.message}\n`)
      }
      if (results.length === 0) {
        this.log(chalk.yellow('No results'))
      } else {
        this.log()
        this.log(chalk.green(`✅ Found ${results.length} similar log entries`))
        if (db.isUsingMockDatabase()) {
          this.log(chalk.cyan('🎯 Demo mode: Results generated from realistic mock data'))
        }
      }
    }
  }

  private buildVectorSearchSql(table: string, qVec: number[], group?: string, since?: string, limit = 20, minLen = 32): string {
    const vectorStr = JSON.stringify(qVec)
    
    let sql = `
      SELECT id, log_group, log_stream, ts_ms, message,
             1 - (embedding <=> CAST('${vectorStr}' AS VECTOR(384))) AS score,
             (embedding <=> CAST('${vectorStr}' AS VECTOR(384))) AS distance
      FROM ${table}
      WHERE LENGTH(message) >= ${minLen}
    `
    
    if (group) {
      sql += ` AND log_group = '${group}'`
    }
    
    if (since) {
      const sinceMs = this.parseSinceToMs(since)
      if (sinceMs > 0) {
        sql += ` AND ts_ms >= ${sinceMs}`
      }
    }
    
    sql += ` ORDER BY distance ASC LIMIT ${limit}`
    
    return sql
  }

  private parseSinceToMs(since: string): number {
    const now = Date.now()
    const match = since.match(/^(\d+)([hd])$/)
    if (!match) return 0
    
    const [, num, unit] = match
    const value = parseInt(num, 10)
    
    if (unit === 'h') {
      return now - (value * 60 * 60 * 1000)
    } else if (unit === 'd') {
      return now - (value * 24 * 60 * 60 * 1000)
    }
    
    return 0
  }

}


