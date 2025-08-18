import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import enquirer from 'enquirer'
import mysql from 'mysql2/promise'
import {getTiDBProfile, parseMySqlDsn, setTiDBProfile} from '../../lib/config.js'

export default class TiDBSetDsn extends Command {
  static description = 'Configure TiDB DSN interactively (or via --dsn) and save as default profile'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dsn mysql://user:pass@host:4000/db',
    '<%= config.bin %> <%= command.id %> --show',
  ]

  static flags = {
    dsn: Flags.string({description: 'MySQL DSN: mysql://user:pass@host:port/db'}),
    name: Flags.string({description: 'Profile name', default: 'default'}),
    show: Flags.boolean({description: 'Show current profile and exit', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TiDBSetDsn)

    if (flags.show) {
      const prof = await getTiDBProfile(flags.name)
      if (!prof) {
        this.log(chalk.yellow('No TiDB profile found.'))
      } else {
        this.log(JSON.stringify({name: flags.name, ...prof}, null, 2))
      }
      return
    }

    let profile = undefined as undefined | {host: string; port?: number; user: string; password?: string; database: string; caPath?: string}
    if (flags.dsn) {
      const parsed = parseMySqlDsn(flags.dsn)
      if (!parsed?.host || !parsed?.user || !parsed?.database) this.error('Invalid DSN. Expected mysql://user:pass@host:port/db')
      profile = parsed!
    } else {
      const {prompt} = enquirer as unknown as {prompt: <T>(q: any) => Promise<T>}
      const ans = await prompt<{host: string; port: string; user: string; password: string; database: string; caPath: string}>([
        {type: 'input', name: 'host', message: 'TiDB host', initial: 'tidb.xxx.clusters.tidb-cloud.com'},
        {type: 'input', name: 'port', message: 'TiDB port', initial: '4000'},
        {type: 'input', name: 'user', message: 'TiDB user'},
        {type: 'password', name: 'password', message: 'TiDB password'},
        {type: 'input', name: 'database', message: 'TiDB database', initial: 'test'},
        {type: 'input', name: 'caPath', message: 'Path to CA certificate (required for Dedicated/Essential)', initial: ''},
      ])
      profile = {host: ans.host, port: Number(ans.port), user: ans.user, password: ans.password, database: ans.database, caPath: ans.caPath || undefined}
    }

    // Test connection
    this.log('Testing connection...')
    const ssl = /tidbcloud\.com$/i.test(profile!.host)
      ? (profile!.caPath ? {ca: await this.readFileSafe(profile!.caPath), minVersion: 'TLSv1.2', rejectUnauthorized: true} : {minVersion: 'TLSv1.2', rejectUnauthorized: true})
      : undefined
    const pool = mysql.createPool({
      host: profile!.host,
      port: profile!.port ?? 4000,
      user: profile!.user,
      password: profile!.password,
      database: profile!.database,
      waitForConnections: true,
      connectionLimit: 1,
      ...(ssl ? {ssl} : {}),
    })
    try {
      const conn = await pool.getConnection()
      await conn.query('SELECT 1')
      conn.release()
      await pool.end()
    } catch (e: any) {
      await pool.end().catch(() => {})
      this.error(`Failed to connect: ${e?.message || String(e)}`)
      return
    }

    await setTiDBProfile(flags.name, profile!, true)
    this.log(chalk.green(`Saved TiDB profile '${flags.name}'.`))
  }

  private async readFileSafe(p: string): Promise<string | undefined> {
    if (!p) return undefined
    try {
      const fs = await import('node:fs/promises')
      const data = await fs.readFile(p, 'utf8')
      return data
    } catch {
      return undefined
    }
  }
}


