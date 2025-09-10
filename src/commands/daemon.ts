import {Command, Flags} from '@oclif/core'
import {spawn} from 'node:child_process'
import mysql from '../lib/mysql-shim.js'
import {parseMySqlDsn, setLlmConfig} from '../lib/config.js'
import {ensureAutoIrTables, getCursor, setCursor, upsertIncidentByDedupe} from '../lib/db.js'
import {ToolManager} from '../lib/tools/index.js'
import {LlmClient, LlmMessage} from '../lib/llm/client.js'
import crypto from 'node:crypto'
import {SNSClient} from '@aws-sdk/client-sns'
import {S3Client} from '@aws-sdk/client-s3'
import {generateAndSendIncidentReport} from '../lib/alerts.js'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

export default class Daemon extends Command {
  static description = 'Run the AutoIR ingestion + detection daemon (intended for container/Fargate)'

  static flags = {
    groups: Flags.string({description: 'Comma separated CloudWatch Log Groups. Overrides LOG_GROUPS env.'}),
    region: Flags.string({description: 'AWS region. Overrides AWS_REGION env.'}),
    sagemakerEndpoint: Flags.string({description: 'SageMaker embedding endpoint. Overrides env SAGEMAKER_ENDPOINT'}),
    sagemakerRegion: Flags.string({description: 'SageMaker region. Overrides env SAGEMAKER_REGION'}),
    // Alerting options
    alertsEnabled: Flags.boolean({description: 'Enable LLM-based alerting loop', default: false}),
    alertsIntervalSec: Flags.integer({description: 'Alerting interval (seconds)', default: 300}),
    alertsWindowMin: Flags.integer({description: 'Window of logs to analyze (minutes)', default: 10}),
    alertsMinConfidence: Flags.integer({description: 'Minimum confidence (0-100) to notify', default: 60}),
    alertsMinSeverity: Flags.string({description: 'Minimum severity to notify', options: ['info','low','medium','high','critical'], default: 'medium'}),
    alertsChannels: Flags.string({description: 'Comma-separated alert channels: slack,sns', default: ''}),
    slackWebhookUrl: Flags.string({description: 'Slack webhook URL for alerts'}),
    snsTopicArn: Flags.string({description: 'SNS Topic ARN for alerts'}),
    alertsMaxEvents: Flags.integer({description: 'Max events to scan per tick', default: 1000}),
    alertsMaxSamplesPerIssue: Flags.integer({description: 'Max sample messages per detected issue', default: 5}),
    table: Flags.string({description: 'TiDB table with logs', default: 'autoir_log_events'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Daemon)
    const groups = (flags.groups || process.env.LOG_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean)
    const region = flags.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
    const smEndpoint = flags.sagemakerEndpoint || process.env.SAGEMAKER_ENDPOINT
    const smRegion = flags.sagemakerRegion || process.env.SAGEMAKER_REGION || region

    if (!groups.length) {
      this.log('No log groups provided. Set --groups or LOG_GROUPS env. Exiting.')
      return
    }
    if (!smEndpoint) {
      this.log('No SAGEMAKER_ENDPOINT provided. Set flag or env. Exiting.')
      return
    }

    const children: ReturnType<typeof spawn>[] = []

    for (const g of groups) {
      const args = ['logs','tail', g, '--follow','--format','detailed']
      if (region) args.unshift('--region', region)
      const tail = spawn('aws', args)
      tail.stdout.on('data', (d) => process.stdout.write(`[tail ${g}] ${d}`))
      tail.stderr.on('data', (d) => process.stderr.write(`[tail ${g} ERR] ${d}`))

      // Pipe into our logs tail command which does TiDB + embeddings
      const nodeArgs = ['./bin/run.js','logs','tail', g,'--sagemaker-endpoint', smEndpoint]
      if (smRegion) nodeArgs.push('--sagemaker-region', smRegion)
      if (region) nodeArgs.push('--region', region)
      const worker = spawn(process.execPath, nodeArgs)
      worker.stdout.on('data', (d) => process.stdout.write(`[worker ${g}] ${d}`))
      worker.stderr.on('data', (d) => process.stderr.write(`[worker ${g} ERR] ${d}`))

      children.push(tail, worker)
    }

    process.on('SIGINT', () => {
      for (const c of children) { try { c.kill() } catch {} }
      process.exit(0)
    })

    // Start alerting loop if enabled
    const alertsEnabled = flags.alertsEnabled || /^true$/i.test(process.env.ALERTS_ENABLED || '')
    if (alertsEnabled) {
      this.log(`[alerts] enabled: interval=${flags.alertsIntervalSec || process.env.ALERTS_INTERVAL_SEC || 300}s, window=${flags.alertsWindowMin || process.env.ALERTS_WINDOW_MINUTES || 10}m`)
      void this.startAlertingLoop(flags)
    } else {
      this.log('[alerts] disabled')
    }

    await new Promise<void>(() => {})
  }

  private async startAlertingLoop(flags: any): Promise<void> {
    // Resolve TiDB DSN
    const dsn = process.env.TIDB_DSN
    if (!dsn) {
      this.log('[alerts] TIDB_DSN not set. Alerting will be skipped.')
      return
    }
    const conn = parseMySqlDsn(dsn)
    if (!conn) {
      this.log('[alerts] Failed to parse TIDB_DSN. Skipping alerting.')
      return
    }

    const pool = mysql.createPool({
      host: conn.host,
      port: conn.port ?? 4000,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      waitForConnections: true,
      connectionLimit: 4,
      ...( /tidbcloud\.com$/i.test(conn.host) ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}} : {}),
    })

    try {
      // Ensure tables exist
      await ensureAutoIrTables(pool, flags.table)
    } catch {}

    // Prepare LLM (headless). Prefer OpenAI if OPENAI_API_KEY set; otherwise try AWS endpoint if configured previously.
    try {
      if (process.env.OPENAI_API_KEY) {
        await setLlmConfig({provider: 'openai', openaiApiKey: process.env.OPENAI_API_KEY, openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'})
      }
    } catch {}
    const tools = new ToolManager()
    const llm = new LlmClient(tools)
    try { await llm.ensureConfigured(process.env.KIMI_ENDPOINT || undefined) } catch {}

    const snsArn = flags.snsTopicArn || process.env.SNS_TOPIC_ARN
    const region = flags.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
    const snsClient = snsArn ? new SNSClient({region}) : undefined
    const s3Client = new S3Client({region})
    const reportsBucket = process.env.REPORTS_BUCKET || 'autoir-reports'

    const intervalSec = Number(flags.alertsIntervalSec || process.env.ALERTS_INTERVAL_SEC || 300)
    const windowMin = Number(flags.alertsWindowMin || process.env.ALERTS_WINDOW_MINUTES || 10)
    const minConfidence = Number(flags.alertsMinConfidence || process.env.ALERTS_MIN_CONFIDENCE || 60) / 100
    const minSeverity = String(flags.alertsMinSeverity || process.env.ALERTS_MIN_SEVERITY || 'medium') as 'info'|'low'|'medium'|'high'|'critical'
    const channels = (flags.alertsChannels || process.env.ALERTS_CHANNELS || '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const slackWebhook = flags.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL
    const maxEvents = Number(flags.alertsMaxEvents || process.env.ALERTS_MAX_EVENTS || 1000)
    const maxSamples = Number(flags.alertsMaxSamplesPerIssue || process.env.ALERTS_MAX_SAMPLES_PER_ISSUE || 5)
    const table = flags.table || process.env.ALERTS_LOGS_TABLE || 'autoir_log_events'

    const severities: Array<'info'|'low'|'medium'|'high'|'critical'> = ['info','low','medium','high','critical']
    const minSeverityIdx = severities.indexOf(minSeverity)

    const tick = async () => {
      const now = Date.now()
      const sinceCursor = await getCursor(pool, 'alerts')
      const windowStart = Math.max(now - windowMin * 60_000, sinceCursor || now - windowMin * 60_000)
      try {
        const [rows] = await pool.query(
          `SELECT id, log_group, log_stream, ts_ms, message
           FROM \`${table}\`
           WHERE ts_ms > ? AND ts_ms <= ? AND CHAR_LENGTH(message) >= 10
           ORDER BY ts_ms ASC
           LIMIT ?`,
          [windowStart, now, maxEvents],
        )
        const events = rows as Array<{id: string; log_group: string; log_stream: string; ts_ms: number; message: string}>
        if (!events.length) {
          await setCursor(pool, 'alerts', now)
          return
        }

        // Basic heuristics
        const keyword = /(error|exception|timeout|failed|panic|oom|deadlock|throttle|5\d{2})/i
        const suspects = events.filter(e => keyword.test(e.message))
        const groupsMap = new Map<string, number>()
        for (const e of events) groupsMap.set(e.log_group, (groupsMap.get(e.log_group) || 0) + 1)
        const topGroups = [...groupsMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 5)

        if (!suspects.length && !topGroups.length) {
          await setCursor(pool, 'alerts', events[events.length-1].ts_ms)
          return
        }

        // Build compact context
        const sample = suspects.slice(0, Math.min(maxSamples, suspects.length))
        const aggregates = topGroups.map(([name,count]) => ({group: name, count}))

        // Prepare LLM prompt
        const provider = llm.getProviderLabel()
        const system = llm.buildSystemPrompt()
        const messages: LlmMessage[] = [
          {role: 'system', content: system},
          {role: 'user', content: [
            'You are an SRE assistant. Analyze the recent logs and identify any incidents.',
            'Return STRICT JSON array under key incidents, no prose. Schema per incident:',
            '{"title": string, "severity": "info|low|medium|high|critical", "confidence": number (0-1), "dedupe_key": string,',
            ' "summary": string, "suggested_actions": string[], "tags": string[] }',
            `Time range: ${new Date(windowStart).toISOString()} .. ${new Date(now).toISOString()}`,
            `Aggregates: ${JSON.stringify(aggregates).slice(0, 1500)}`,
            `Samples (${sample.length}):`,
            ...sample.map(s => `- [${new Date(s.ts_ms).toISOString()}] ${s.log_group} ${s.log_stream}: ${truncate(s.message, 500)}`),
            'Output: {"incidents": [ ... ]}',
          ].join('\n')}
        ]

        let parsed: any = null
        try {
          const {content} = await llm.send(messages, {temperature: 0.2, maxTokens: 800, json: true})
          parsed = safeParseJson(content)
        } catch (e) {
          this.log(`[alerts] LLM error (${provider}): ${e instanceof Error ? e.message : String(e)}`)
        }
        const incidents: any[] = Array.isArray(parsed?.incidents) ? parsed.incidents : []
        for (const inc of incidents) {
          const severity = normalizeSeverity(inc?.severity)
          const confidence = clampNumber(inc?.confidence, 0, 1)
          if (severities.indexOf(severity) < minSeverityIdx || confidence < minConfidence) continue

          const dedupeKey = String(inc?.dedupe_key || `${inc?.title || 'incident'}|${hashString(JSON.stringify(aggregates).slice(0,300))}|${new Date(now).toISOString().slice(0,13)}`)
          const {created, id} = await upsertIncidentByDedupe(pool, {
            dedupe_key: dedupeKey,
            severity,
            title: truncate(String(inc?.title || 'Detected issue'), 255),
            summary: truncate(String(inc?.summary || ''), 1000),
            affected_group: aggregates[0]?.group || null,
            affected_stream: null,
            first_ts_ms: events[0]?.ts_ms || now,
            last_ts_ms: events[events.length-1]?.ts_ms || now,
            event_count: events.length,
            sample_ids: sample.map(s => s.id),
            vector_context: {aggregates, sample_count: sample.length, confidence, tags: inc?.tags || []},
            status: 'open',
          })

          if (created) {
            // Notify
            const title = `[${severity.toUpperCase()}][${Math.round(confidence*100)}%] ${inc?.title || 'Issue detected'}`
            if (channels.includes('sns') && snsClient && snsArn) {
              try {
                const report = await generateAndSendIncidentReport({
                  region,
                  bucket: reportsBucket,
                  topicArn: snsArn,
                  incident: {
                    id,
                    title,
                    severity,
                    confidence,
                    summary: inc?.summary || '',
                    aggregates,
                    samples: sample.slice(0, Math.min(sample.length, 5)).map(s => ({
                      timestamp: new Date(s.ts_ms).toISOString(),
                      group: s.log_group,
                      stream: s.log_stream,
                      message: s.message
                    }))
                  }
                })
                this.log(`[alerts] Report available: ${report.url}`)
              } catch (e) {
                this.log(`[alerts] SNS/PDF error: ${String((e as any)?.message || e)}`)
              }
            }
          }
        }

        await setCursor(pool, 'alerts', events[events.length-1].ts_ms)
      } catch (e) {
        this.log(`[alerts] tick error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Run forever
    const loop = async () => {
      while (true) {
        const started = Date.now()
        await tick()
        const elapsed = Date.now() - started
        const sleepMs = Math.max(0, intervalSec*1000 - elapsed)
        await sleep(sleepMs)
      }
    }
    void loop()
  }
}

function sleep(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)) }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n-3) + '...' : s }
function clampNumber(x: any, min: number, max: number): number { const v = Number(x); if (Number.isFinite(v)) return Math.max(min, Math.min(max, v)); return min }
function normalizeSeverity(s: any): 'info'|'low'|'medium'|'high'|'critical' {
  const t = String(s || '').toLowerCase()
  if (t === 'critical') return 'critical'
  if (t === 'high') return 'high'
  if (t === 'medium') return 'medium'
  if (t === 'low') return 'low'
  return 'medium'
}
function hashString(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
}
async function postSlack(webhook: string, title: string, text: string): Promise<void> {
  const payload = { text: `*${title}*\n${text}` }
  const {stdout, stderr} = await execFileAsync('curl', ['-sS', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify(payload), webhook])
  if (stderr && stderr.trim()) throw new Error(stderr.trim())
}
function safeParseJson(s: string | undefined): any {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return {} }
}
