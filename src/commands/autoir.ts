import {Command, Flags} from '@oclif/core'
import mysql from 'mysql2/promise'
import {StartupScreen, StartupProcess} from '../lib/startup.js'
import {getTiDBProfile, parseMySqlDsn} from '../lib/config.js'
import LogsSearch from './logs/search.js'

enum AppState {
  INITIALIZING = 'initializing',
  SEARCH = 'search',
  EXITING = 'exiting'
}

export default class AutoIR extends Command {
  static description = 'AutoIR - Intelligent Log Analysis Platform'

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
    'no-animation': Flags.boolean({description: 'Disable startup animation', default: false}),
  }

  private state: AppState = AppState.INITIALIZING
  private dbPool?: mysql.Pool

  async run(): Promise<void> {
    const {flags} = await this.parse(AutoIR)

    try {
      // State machine
      while (this.state !== AppState.EXITING) {
        switch (this.state) {
          case AppState.INITIALIZING:
            await this.runInitialization(flags)
            this.state = AppState.SEARCH
            break
            
          case AppState.SEARCH:
            await this.runSearchInterface(flags)
            this.state = AppState.EXITING
            break
        }
      }
    } catch (error: any) {
      this.error(`Application error: ${error.message}`)
    } finally {
      await this.cleanup()
    }
  }

  private async runInitialization(flags: any): Promise<void> {
    const processes: StartupProcess[] = [
      {
        name: 'tidb_connection',
        description: 'Connecting to TiDB database',
        run: async () => {
          const conn = await this.resolveTiDBConn(flags)
          this.dbPool = mysql.createPool({
            host: conn.host,
            port: conn.port ?? 4000,
            user: conn.user,
            password: conn.password,
            database: conn.database,
            waitForConnections: true,
            connectionLimit: 5,
            ...( /tidbcloud\.com$/i.test(conn.host) ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}} : {}),
          })
          
          // Test the connection
          const testConn = await this.dbPool.getConnection()
          testConn.release()
          
          return {host: conn.host, database: conn.database}
        }
      }
      // Future processes can be added here:
      // - SageMaker endpoint health check
      // - Index verification
      // - Cache initialization
      // - etc.
    ]

    const startup = new StartupScreen({
      title: 'AutoIR - Intelligent Log Analysis Platform',
      processes,
      animationEnabled: !flags['no-animation']
    })

    try {
      await startup.runStartup()
    } finally {
      startup.cleanup()
    }
  }

  private async runSearchInterface(flags: any): Promise<void> {
    if (!this.dbPool) {
      throw new Error('Database not initialized')
    }

    // Create a modified search command that uses our existing pool
    const searchCommand = new LogsSearch(this.argv, this.config)
    
    // Monkey patch the search command to use our pool
    const originalRun = searchCommand.run.bind(searchCommand)
    searchCommand.run = async () => {
      // We'll need to modify the search command to accept an existing pool
      // For now, let it create its own connection
      return originalRun()
    }

    await searchCommand.run()
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

  private async cleanup(): Promise<void> {
    if (this.dbPool) {
      await this.dbPool.end()
    }
  }
}
