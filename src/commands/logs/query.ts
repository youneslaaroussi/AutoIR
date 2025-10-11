import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {SageMakerRuntimeClient, InvokeEndpointCommand} from '@aws-sdk/client-sagemaker-runtime'
import {OpenSearchClient} from '../../lib/aws/opensearch.js'

type Row = {
  id: string
  log_group: string
  log_stream: string
  ts_ms: number
  message: string
}

export default class LogsQuery extends Command {
  static description = 'Semantic search over ingested logs stored in Amazon OpenSearch (vector search)'

  static examples = [
    '<%= config.bin %> <%= command.id %> "stripe error checkout" --region us-east-1 --sagemaker-endpoint autoir-embed-ep-srv --sagemaker-region us-east-1',
  ]

  static args = {
    query: Args.string({description: 'Free-text query to search for', required: true}),
  }

  static flags = {
    region: Flags.string({char: 'r', description: 'AWS region for CloudWatch (unused here, for symmetry)'}),
    profile: Flags.string({char: 'p', description: 'AWS profile (unused here, for symmetry)'}),

    index: Flags.string({description: 'OpenSearch index name', default: 'autoir_log_events'}),
    group: Flags.string({description: 'Filter by CloudWatch log group name'}),
    since: Flags.string({description: 'Time window for candidates (e.g., 1h, 24h, 7d)'}),
    limit: Flags.integer({description: 'Top results to return', default: 20}),
    'min-len': Flags.integer({description: 'Minimum message length to consider', default: 32}),

    'opensearch-endpoint': Flags.string({description: 'OpenSearch endpoint', env: 'OPENSEARCH_ENDPOINT'}),
    'opensearch-region': Flags.string({description: 'OpenSearch region', env: 'OPENSEARCH_REGION'}),

    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint for embeddings', required: true}),
    'sagemaker-region': Flags.string({description: 'AWS region for SageMaker endpoint'}),

    json: Flags.boolean({description: 'Output JSON', default: false}),
    debug: Flags.boolean({description: 'Verbose logs', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(LogsQuery)
    const queryText = args.query

    const osEndpoint = flags['opensearch-endpoint'] || process.env.OPENSEARCH_ENDPOINT
    const osRegion = flags['opensearch-region'] || process.env.OPENSEARCH_REGION || flags.region
    if (!osEndpoint || !osRegion) this.error('OpenSearch endpoint/region required')
    const os = new OpenSearchClient({endpoint: osEndpoint, region: osRegion})

    // Embed the query via SageMaker
    const qVec = await this.embedQuerySageMaker(queryText, flags['sagemaker-endpoint']!, flags['sagemaker-region'] || flags.region)
    if (!qVec.length) {
      this.error('Failed to generate embedding for the query. Ensure the SageMaker endpoint is healthy and returns vectors.')
      return
    }

    // Server-side vector search using TiDB VECTOR and cosine distance
    const top = await os.searchByVector(
      flags.index!,
      qVec,
      flags.limit!,
      {group: flags.group, sinceMs: flags.since ? this.parseSince(flags.since) : undefined, minLen: flags['min-len']!}
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

    // nothing to close
  }

  // Vector search now handled by OpenSearch client

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


