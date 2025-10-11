import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'node:child_process'
import {setTimeout as wait} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import chalk from 'chalk'
import ora from 'ora'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'
import {OpenSearchClient} from '../../lib/aws/opensearch.js'

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

  static description = 'Tail CloudWatch logs for a group, embed with SageMaker, and store into Amazon OpenSearch (vector search)'

  static examples = [
    '<%= config.bin %> <%= command.id %> /aws/lambda/my-func',
    '<%= config.bin %> <%= command.id %> /aws/lambda/my-func --no-embed',
  ]

  static flags = {
    profile: Flags.string({char: 'p', description: 'AWS profile to use'}),
    region: Flags.string({char: 'r', description: 'AWS region'}),
    'start-time': Flags.string({description: 'RFC3339 or relative like 15m'}),
    follow: Flags.boolean({description: 'Follow new log events', default: true}),
    embed: Flags.boolean({description: 'Generate embeddings with a SageMaker endpoint and store for vector search', default: true}),
    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint name to use for embeddings'}),
    'sagemaker-region': Flags.string({description: 'AWS region for SageMaker endpoint'}),
    debug: Flags.boolean({description: 'Verbose debug logging of lines, events, embeddings, and inserts', default: false}),
    'batch-size': Flags.integer({description: 'Number of events to batch before insert', default: 2}),
    'flush-interval': Flags.integer({description: 'Flush interval milliseconds', default: 8000}),
    'opensearch-endpoint': Flags.string({description: 'OpenSearch domain/collection endpoint', env: 'OPENSEARCH_ENDPOINT'}),
    'opensearch-region': Flags.string({description: 'OpenSearch region', env: 'OPENSEARCH_REGION'}),
    'index': Flags.string({description: 'OpenSearch index name', default: 'autoir_log_events'}),
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
      this.error('Embeddings are required for vector storage. Provide --sagemaker-endpoint and optionally --sagemaker-region.')
      return
    }

    const osEndpoint = flags['opensearch-endpoint'] || process.env.OPENSEARCH_ENDPOINT
    const osRegion = flags['opensearch-region'] || process.env.OPENSEARCH_REGION || flags.region
    if (!osEndpoint || !osRegion) {
      this.error('OpenSearch endpoint/region required. Set --opensearch-endpoint and --opensearch-region or OPENSEARCH_ENDPOINT/OPENSEARCH_REGION env vars.')
    }
    const osIndex = flags.index || 'autoir_log_events'
    const osClient = new OpenSearchClient({endpoint: osEndpoint!, region: osRegion!})

    const idxSpinner = ora(`Ensuring OpenSearch index ${chalk.bold(osIndex)} exists...`).start()
    await osClient.ensureIndex(osIndex, 384)
    idxSpinner.succeed(`Ready index ${chalk.bold(osIndex)}`)

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

        // Index to OpenSearch
        const docs = filteredEvents.map((e, i) => ({
          id: randomUUID(),
          log_group: e.logGroupName,
          log_stream: e.logStreamName,
          ts_ms: e.timestamp,
          message: e.message,
          embedding: filteredEmbeds[i],
        }))
        await osClient.bulkIndex(osIndex, docs)
        this.log(chalk.green(`Indexed ${filteredEvents.length} event(s) into ${osIndex}`))
      } catch (e: any) {
        const errMsg = e?.message || String(e)
        const sample = batch[0]
        this.log(chalk.red('Failed to index batch: ') + errMsg)
        this.log(chalk.gray(`  Index: ${osIndex}; Batch size: ${batch.length}; Sample: {group: ${sample.logGroupName}, stream: ${sample.logStreamName}, ts: ${sample.timestamp}, msgLen: ${sample.message.length}, embedDims: ${embedDimForLog}}`))
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
      // Structure is: [batch][input][multiple_vectors][384_dims]
      // We need to average the multiple vectors for each input
      const out: number[][] = []
      for (const batchItem of payload as number[][][][]) {
        const vectors = batchItem[0]
        if (!vectors || vectors.length === 0) { out.push([]); continue }
        const dims = vectors[0].length
        const sums = new Array(dims).fill(0)
        for (const vector of vectors) {
          for (let i = 0; i < dims; i++) sums[i] += vector[i]
        }
        const avgVector = sums.map(v => v / vectors.length)
        out.push(avgVector)
      }
      return out
    } catch (e: any) {
      // On client error, skip embeddings this round
      return texts.map(() => [])
    }
  }
}
