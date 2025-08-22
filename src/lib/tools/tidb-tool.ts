import {BaseTool} from './base-tool.js'
import {getDatabase} from '../db-factory.js'

export class TiDBQueryTool extends BaseTool {
  readonly name = 'tidb_query'
  readonly description = 'Run a read-only SQL query against the configured TiDB database and return JSON rows and a score summary.'
  readonly parameters = {
    type: 'object',
    properties: {
      sql: {type: 'string', description: 'SELECT-only SQL to execute. No mutations.'},
      limit: {type: 'number', description: 'Max rows to return', default: 100}
    },
    required: ['sql']
  }

  async execute(args: Record<string, any>): Promise<string> {
    this.validateArguments(args)
    let sql: string = String(args.sql || '')
    const limit: number = Math.min(Number(args.limit ?? 100), 1000)

    if (!/^\s*select\s/i.test(sql)) {
      throw new Error('Only SELECT statements are allowed')
    }

    // Sanitize: strip trailing semicolons and whitespace
    sql = sql.trim().replace(/;\s*$/g, '')
    // Avoid double LIMIT: append only if not present (basic heuristic)
    const hasLimit = /\blimit\b/i.test(sql)
    const finalSql = hasLimit ? sql : `${sql} LIMIT ${limit}`

    try {
      const db = await getDatabase()
      const rows = await db.query(finalSql)
      const score = Array.isArray(rows) ? rows.length : 0
      
      // Add demo indicator if using mock
      const meta = {
        limit, 
        appliedLimit: !hasLimit,
        ...(db.isUsingMockDatabase() ? {demo_mode: true, mock_data: true} : {})
      }
      
      return JSON.stringify({rows, score, meta})
    } catch (error) {
      throw new Error(`TiDB query failed: ${error}`)
    }
  }
}
