import {Command, Flags} from '@oclif/core'
import mysql from '../lib/mysql-shim.js'
import {StartupScreen, StartupProcess} from '../lib/startup.js'
import {getTiDBProfile, parseMySqlDsn, readConfig, writeConfig, getFargateConfig, setFargateConfig} from '../lib/config.js'
import blessed from 'blessed'
import contrib from 'blessed-contrib'
import {execFile, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'


const execFileAsync = promisify(execFile)

enum AppState {
  INITIALIZING = 'initializing',
  DASHBOARD = 'dashboard',
  SEARCH = 'search',
  EXITING = 'exiting'
}

interface FargateMetrics {
  serviceName: string
  clusterName: string
  runningCount: number
  pendingCount: number
  desiredCount: number
  cpu: number
  memory: number
  lastUpdated: Date
  status: string
  tasks: Array<{
    taskArn: string
    lastStatus: string
    healthStatus: string
    cpu: string
    memory: string
    createdAt: Date
  }>
}

export default class AutoIR extends Command {
  static description = 'AutoIR - Intelligent Log Analysis Platform'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dashboard',
  ]

  static flags = {
    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint for embeddings'}),
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
    dashboard: Flags.boolean({description: 'Show combined dashboard (Fargate + search)', default: true}),
    cluster: Flags.string({description: 'ECS cluster name for dashboard', default: 'autoir'}),
    service: Flags.string({description: 'ECS service name for dashboard', default: 'autoir'}),
    'auto-bootstrap': Flags.boolean({description: 'Automatically bootstrap missing prerequisites (SageMaker endpoint)', default: true}),
  }

  private state: AppState = AppState.INITIALIZING
  private dbPool?: any
  private smEndpoint?: string
  private smRegion?: string

  async run(): Promise<void> {
    const {flags} = await this.parse(AutoIR)

    try {
      // State machine
      while (this.state !== AppState.EXITING) {
        switch (this.state) {
          case AppState.INITIALIZING:
            await this.runInitialization(flags)
            this.state = flags.dashboard ? AppState.DASHBOARD : AppState.SEARCH
            break
            
          case AppState.DASHBOARD:
            console.log('Transitioning to dashboard state...')
            await this.runDashboard(flags)
            console.log('Dashboard completed, setting state to EXITING')
            this.state = AppState.EXITING
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
    const cfg = await readConfig()

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
      },
      {
        name: 'aws_check',
        description: 'Checking AWS CLI and authentication',
        run: async () => {
          const args = ['sts', 'get-caller-identity', '--output', 'json']
          if (flags.region) args.unshift('--region', flags.region)
          const {stdout} = await execFileAsync('aws', args)
          const identity = JSON.parse(stdout)
          return {account: identity.Account, userId: identity.UserId}
        }
      },
      {
        name: 'sagemaker_endpoint',
        description: 'Validating or creating SageMaker embedding endpoint',
        run: async (updateStatus?: (message: string) => void) => {
          updateStatus?.('Resolving AWS region...')
          const region = await this.resolveAwsRegion(flags)
          if (!region) throw new Error('AWS region not found. Provide --region or configure a default AWS region.')
          updateStatus?.(`Using AWS region: ${region}`)

          updateStatus?.('Resolving SageMaker endpoint...')
          const savedEndpoint = (cfg as any)?.embed?.sagemakerEndpoint as string | undefined
          const endpoint = flags['sagemaker-endpoint'] || savedEndpoint || (flags['auto-bootstrap'] ? 'autoir-embed-ep-srv' : undefined)
          if (!endpoint) throw new Error('No SageMaker endpoint provided. Re-run with --sagemaker-endpoint or enable --auto-bootstrap to create one.')
          updateStatus?.(`Using SageMaker endpoint: ${endpoint}`)

          updateStatus?.('Checking endpoint status...')
          let status = 'Unknown'
          let actualEndpoint = endpoint

          try {
            const {stdout} = await execFileAsync('aws', ['sagemaker', 'describe-endpoint', '--endpoint-name', endpoint, '--region', region, '--output', 'json'])
            const data = JSON.parse(stdout)
            status = data?.EndpointStatus || 'Unknown'
            updateStatus?.(`Endpoint status: ${status}`)
          } catch (e) {
            status = 'NotFound'
            updateStatus?.(`Endpoint '${endpoint}' not found, checking for alternatives...`)

            // Look for any existing InService endpoint
            try {
              const {stdout} = await execFileAsync('aws', ['sagemaker', 'list-endpoints', '--region', region, '--output', 'json'])
              const endpoints = JSON.parse(stdout)
              const inServiceEndpoint = endpoints?.Endpoints?.find((ep: any) => ep.EndpointStatus === 'InService')

              if (inServiceEndpoint) {
                actualEndpoint = inServiceEndpoint.EndpointName
                status = 'InService'
                updateStatus?.(`Found existing InService endpoint: ${actualEndpoint}`)
              } else {
                updateStatus?.('No InService endpoints found')
              }
            } catch (listError) {
              updateStatus?.('Could not list existing endpoints')
            }
          }

          if (status !== 'InService' && flags['auto-bootstrap']) {
            updateStatus?.('Endpoint not ready, starting bootstrap process...')
            await this.runSageMakerBootstrap(endpoint, region, updateStatus)
            updateStatus?.('Bootstrap complete, verifying endpoint...')

            // After bootstrap, wait/verify once
            try {
              const {stdout} = await execFileAsync('aws', ['sagemaker', 'describe-endpoint', '--endpoint-name', endpoint, '--region', region, '--output', 'json'])
              const data = JSON.parse(stdout)
              status = data?.EndpointStatus || 'Unknown'
              updateStatus?.(`Final endpoint status: ${status}`)
            } catch {
              updateStatus?.('Could not verify endpoint status after bootstrap')
            }
          } else if (status === 'InService') {
            updateStatus?.('Endpoint is ready and in service')
          } else if (!flags['auto-bootstrap']) {
            updateStatus?.('Auto-bootstrap disabled, skipping endpoint creation')
          }

          updateStatus?.('Saving endpoint configuration...')
          // Persist resolved endpoint/region (use the actual working endpoint)
          this.smEndpoint = actualEndpoint
          this.smRegion = region
          ;(cfg as any).embed = {
            ...(cfg as any).embed,
            provider: 'sagemaker',
            sagemakerEndpoint: actualEndpoint,
            sagemakerRegion: region,
          }
          await writeConfig(cfg)
          updateStatus?.('Configuration saved successfully')

          return {endpoint: actualEndpoint, status}
        }
      },
      {
        name: 'fargate_daemon',
        description: 'Setting up Fargate daemon for log ingestion',
        run: async (updateStatus?: (message: string) => void) => {
          try {
            const result = await this.onboardFargateDaemon(flags, updateStatus)

            // Save configuration
            await setFargateConfig({
              cluster: result.cluster,
              service: result.service,
            })
            updateStatus?.('Fargate configuration saved successfully')

            return {cluster: result.cluster, service: result.service}
          } catch (error: any) {
            updateStatus?.(`Fargate setup skipped: ${error.message}`)
            return {cluster: 'autoir', service: 'autoir'}
          }
        }
      },
    ]

    const startup = new StartupScreen({
      title: 'AutoIR - Intelligent Log Analysis Platform',
      processes,
      animationEnabled: !flags['no-animation']
    })

    try {
      // First-run intro overlay
      const firstRun = !(cfg as any)?.__firstRunCompleted
      if (firstRun) {
        const screen = startup.getScreen()
        const modal = blessed.box({
          parent: screen,
          top: 'center', left: 'center', width: '70%', height: '40%',
          border: {type: 'line'}, label: ' Welcome to AutoIR ', tags: true,
          style: {fg: 'white', bg: 'black', border: {fg: 'cyan'}},
          content: '{center}AutoIR will check your TiDB connection, AWS auth, and embedding endpoint.\n\nAfter setup, a combined dashboard with built-in semantic search will open.\\n\\nPress any key to continue.{/center}'
        })
        screen.render()
        await new Promise<void>(resolve => screen.once('keypress', () => resolve()))
        modal.destroy()
        screen.render()
        ;(cfg as any).__firstRunCompleted = true
        await writeConfig(cfg)
      }

      await startup.runStartup()
    } finally {
      startup.cleanup()
    }
  }

  private async runDashboard(flags: any): Promise<void> {
    const {ScreenManager} = await import('../lib/screen-manager.js')
    const {SearchScreen} = await import('../screens/search.js')
    const {MetricsScreen} = await import('../screens/metrics.js')
    const {DaemonScreen} = await import('../screens/daemon.js')
    const {LogsScreen} = await import('../screens/logs.js')

    const context = {
      dbPool: this.dbPool,
      smEndpoint: this.smEndpoint,
      smRegion: this.smRegion,
      flags,
      state: this.state
    }

    const screenManager = new ScreenManager(context)

    // Register all screens
    screenManager.registerScreen(new SearchScreen())
    screenManager.registerScreen(new MetricsScreen())
    screenManager.registerScreen(new DaemonScreen())
    screenManager.registerScreen(new LogsScreen())

    // Start with menu screen
    await screenManager.showMenuScreen()

    // Keep running until exit
    return new Promise((resolve) => {
      const checkState = () => {
        if (this.state !== AppState.DASHBOARD) {
          screenManager.cleanup()
          resolve()
        } else {
          setTimeout(checkState, 100)
        }
      }
      checkState()
    })
  }

  private async runSearchInterface(flags: any): Promise<void> {
    // Deprecated: search is now embedded in the dashboard
    this.state = AppState.DASHBOARD
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

  private async promptUserModal(screen: blessed.Widgets.Screen, question: string, defaultValue?: string): Promise<string> {
    return new Promise((resolve) => {
      const modal = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '60%',
        height: 8,
        border: {type: 'line'},
        style: {fg: 'white', bg: 'black', border: {fg: 'cyan'}},
        label: ' User Input ',
        tags: true
      })

      const questionText = blessed.text({
        parent: modal,
        top: 1,
        left: 2,
        width: '100%-4',
        content: question,
        tags: true,
        style: {fg: 'yellow'}
      })

      const input = blessed.textbox({
        parent: modal,
        top: 3,
        left: 2,
        width: '100%-4',
        height: 1,
        border: {type: 'line'},
        style: {border: {fg: 'green'}},
        inputOnFocus: true
      })

      const instructions = blessed.text({
        parent: modal,
        bottom: 1,
        left: 2,
        width: '100%-4',
        content: `Default: ${defaultValue || 'none'} | Press Enter to confirm, Escape to use default`,
        style: {fg: 'gray'},
        tags: true
      })

      if (defaultValue) {
        input.setValue(defaultValue)
      }

      screen.append(modal)
      input.focus()
      screen.render()

      const cleanup = () => {
        modal.destroy()
        screen.render()
      }

      input.on('submit', (value: string) => {
        cleanup()
        resolve(value.trim() || defaultValue || '')
      })

      input.key('escape', () => {
        cleanup()
        resolve(defaultValue || '')
      })

      screen.key('escape', () => {
        cleanup()
        resolve(defaultValue || '')
      })
    })
  }

  private async onboardSageMakerEndpoint(updateStatus?: (message: string) => void): Promise<{endpoint: string, region: string}> {
    updateStatus?.('Setting up SageMaker embedding endpoint...')

    // Get current config
    const cfg = await readConfig()

    // Determine region
    let region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || (cfg as any)?.embed?.sagemakerRegion
    if (!region) {
      try {
        const {stdout} = await execFileAsync('aws', ['configure', 'get', 'region'])
        region = stdout?.toString?.().trim()
      } catch {}
    }

    if (!region) {
      region = 'us-east-1' // Default fallback
    }

    updateStatus?.(`Using AWS region: ${region}`)

    // Check for existing endpoint
    const savedEndpoint = (cfg as any)?.embed?.sagemakerEndpoint
    let endpoint = savedEndpoint || 'autoir-embed-ep' // Use default if none saved

    updateStatus?.(`Using SageMaker endpoint: ${endpoint}`)

    // Check if endpoint exists
    let status = 'Unknown'
    try {
      const {stdout} = await execFileAsync('aws', ['sagemaker', 'describe-endpoint', '--endpoint-name', endpoint, '--region', region, '--output', 'json'])
      const data = JSON.parse(stdout)
      status = data?.EndpointStatus || 'Unknown'
      updateStatus?.(`Endpoint status: ${status}`)
    } catch (e) {
      status = 'NotFound'
      updateStatus?.('Endpoint not found')

      // Look for any existing InService endpoint
      try {
        const {stdout} = await execFileAsync('aws', ['sagemaker', 'list-endpoints', '--region', region, '--output', 'json'])
        const endpoints = JSON.parse(stdout)
        const inServiceEndpoint = endpoints?.Endpoints?.find((ep: any) => ep.EndpointStatus === 'InService')

        if (inServiceEndpoint) {
          endpoint = inServiceEndpoint.EndpointName
          status = 'InService'
          updateStatus?.(`Found existing InService endpoint: ${endpoint}`)
        }
      } catch (listError) {
        updateStatus?.('Could not list existing endpoints')
      }
    }

    // Bootstrap if needed
    if (status !== 'InService') {
      updateStatus?.('🚀 Starting SageMaker endpoint bootstrap...')
      updateStatus?.('This may take 10-20 minutes...')

      await this.runSageMakerBootstrap(endpoint, region, (msg: string) => {
        updateStatus?.(`Bootstrap: ${msg}`)
      })

      updateStatus?.('✅ SageMaker endpoint ready!')
    } else {
      updateStatus?.('✅ SageMaker endpoint already ready!')
    }

    return {endpoint, region}
  }

  private async onboardFargateDaemon(flags: any, updateStatus?: (message: string) => void): Promise<{cluster: string, service: string}> {
    updateStatus?.('Setting up Fargate daemon for log ingestion...')

    // Get current config
    const fargateCfg = await getFargateConfig()

    // Determine cluster and service names
    let cluster = flags.cluster || fargateCfg?.cluster || 'autoir'
    let service = flags.service || fargateCfg?.service || 'autoir'

    updateStatus?.(`Using ECS cluster: ${cluster}`)
    updateStatus?.(`Using ECS service: ${service}`)

    // Check if service exists
    try {
      const {stdout} = await execFileAsync('aws', ['ecs', 'describe-services', '--cluster', cluster, '--services', service, '--output', 'json'])
      const data = JSON.parse(stdout)
      const svc = data.services?.[0]

      if (svc) {
        updateStatus?.(`Fargate daemon status: ${svc.status}`)
        if (svc.status === 'ACTIVE') {
          updateStatus?.('✅ Fargate daemon is already running!')
          return {cluster, service}
        }
      }
    } catch (e) {
      updateStatus?.('Fargate daemon not found - will show deployment option in dashboard')
    }

    // Skip deployment during startup - show option in dashboard instead
    updateStatus?.('Fargate daemon setup available in dashboard (press "d" key)')
    return {cluster, service}
  }

  private async runSageMakerBootstrap(endpoint: string, region: string, updateStatus?: (message: string) => void): Promise<void> {
    updateStatus?.('Starting SageMaker bootstrap process...')

    return new Promise((resolve, reject) => {
      const bootstrapProcess = spawn(process.execPath, ['./bin/run.js', 'aws', 'sagemaker-bootstrap', '--region', region, '--endpoint', endpoint], {
        stdio: ['inherit', 'pipe', 'pipe']
      })

      let outputBuffer = ''
      let errorBuffer = ''

      const updateOutput = () => {
        const lines = outputBuffer.split('\n').filter(line => line.trim())
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1]
          updateStatus?.(`Bootstrap: ${lastLine}`)
        }
      }

      bootstrapProcess.stdout?.on('data', (data) => {
        const output = data.toString()
        outputBuffer += output
        updateOutput()
      })

      bootstrapProcess.stderr?.on('data', (data) => {
        const error = data.toString()
        errorBuffer += error
        // Show errors as well
        const lines = error.split('\n').filter((line: string) => line.trim())
        if (lines.length > 0) {
          updateStatus?.(`Bootstrap error: ${lines[lines.length - 1]}`)
        }
      })

      bootstrapProcess.on('close', (code) => {
        if (code === 0) {
          updateStatus?.('Bootstrap completed successfully')
          resolve()
        } else {
          const error = new Error(`Bootstrap failed with exit code ${code}. Error: ${errorBuffer}`)
          updateStatus?.(`Bootstrap failed: ${error.message}`)
          reject(error)
        }
      })

      bootstrapProcess.on('error', (error) => {
        updateStatus?.(`Bootstrap process error: ${error.message}`)
        reject(error)
      })

      // Update status periodically to show we're still working
      const progressInterval = setInterval(() => {
        updateOutput()
      }, 1000)

      // Clear interval when process ends
      bootstrapProcess.on('close', () => clearInterval(progressInterval))
      bootstrapProcess.on('error', () => clearInterval(progressInterval))
    })
  }

  private async resolveAwsRegion(flags: any): Promise<string | undefined> {
    const fromFlags = flags['sagemaker-region'] || flags.region
    if (fromFlags) return fromFlags
    const fromEnv = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
    if (fromEnv) return fromEnv
    const fromCfg = (await readConfig())?.embed?.sagemakerRegion
    if (fromCfg) return fromCfg
    // Fallback to AWS CLI configured region
    try {
      const {stdout} = await execFileAsync('aws', ['configure', 'get', 'region'])
      const r = stdout?.toString?.().trim()
      if (r) return r
    } catch {}
    try {
      const {stdout} = await execFileAsync('aws', ['configure', 'get', 'default.region'])
      const r = stdout?.toString?.().trim()
      if (r) return r
    } catch {}
    try {
      const {stdout} = await execFileAsync('aws', ['configure', 'list'])
      const line = stdout.split('\n').find(l => /region\s+\*/.test(l) || /^\s*region\s+/.test(l))
      const m = line ? /region\s+\*?\s+(\S+)/.exec(line) : undefined
      if (m && m[1] && m[1] !== 'None') return m[1]
    } catch {}
    return undefined
  }

  private async embedQuerySageMaker(query: string, endpoint: string, region?: string): Promise<number[]> {
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
    const vec: number[] = Array.isArray(data) ? (Array.isArray(data[0]) ? data[0] : data) : (Array.isArray(data.embeddings) ? data.embeddings : [])
    if (!Array.isArray(vec) || vec.length === 0) throw new Error('Embedding endpoint returned no vector')
    return vec.map((v: any) => Number(v))
  }

  private async searchByVector(
    pool: any,
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
}