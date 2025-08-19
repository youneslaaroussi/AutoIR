import {BaseTool} from './base-tool.js'
import mysql from 'mysql2/promise'
import {getTiDBProfile} from '../config.js'

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
    const sql: string = args.sql
    const limit: number = Math.min(Number(args.limit ?? 100), 1000)

    if (!/^\s*select\s/i.test(sql)) {
      throw new Error('Only SELECT statements are allowed')
    }

    const profile = await getTiDBProfile('default')
    if (!profile) throw new Error('TiDB profile not configured. Run main app to set it.')

    const pool = mysql.createPool({
      host: profile.host,
      port: profile.port ?? 4000,
      user: profile.user,
      password: profile.password,
      database: profile.database,
      waitForConnections: true,
      connectionLimit: 2,
      ...( /tidbcloud\.com$/i.test(profile.host) ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}} : {}),
    })

    try {
      const [rows] = await pool.query({sql: `${sql} LIMIT ${limit}`, rowsAsArray: false})
      const json = JSON.stringify(rows)
      const score = Array.isArray(rows) ? rows.length : 0
      return JSON.stringify({rows: JSON.parse(json), score, meta: {limit}})
    } finally {
      await pool.end()
    }
  }
}
