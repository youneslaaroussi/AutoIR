import {Args, Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

export default class LogsLatest extends Command {
  static args = {
    group: Args.string({description: 'CloudWatch Logs group name', required: true}),
  }

  static description = 'Fetch latest log events from an AWS CloudWatch Logs group'

  static examples = [
    '<%= config.bin %> <%= command.id %> /aws/lambda/my-func --limit 50',
    '<%= config.bin %> <%= command.id %> /aws/lambda/my-func --stream my-stream',
  ]

  static flags = {
    profile: Flags.string({char: 'p', description: 'AWS profile to use'}),
    region: Flags.string({char: 'r', description: 'AWS region'}),
    stream: Flags.string({
      char: 's',
      description: 'Specific log stream name. If omitted, the most recent stream is used',
    }),
    limit: Flags.integer({
      char: 'l',
      description: 'Max number of events to return',
      default: 50,
    }),
    start: Flags.string({
      description: 'Start time (RFC3339, e.g. 2025-01-01T00:00:00Z) or relative (e.g. 15m, 2h)',
    }),
    json: Flags.boolean({description: 'Output raw JSON', default: false}),
    'dry-run': Flags.boolean({description: 'Show commands without executing', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(LogsLatest)
    const baseAwsArgs: string[] = []
    if (flags.profile) baseAwsArgs.push('--profile', flags.profile)
    if (flags.region) baseAwsArgs.push('--region', flags.region)

    // Resolve start time
    let startTimeParam: string[] = []
    if (flags.start) {
      // Pass-through to AWS CLI; if relative strings are provided, try to compute epoch ms
      const maybeRelative = /^\d+\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/i
      if (maybeRelative.test(flags.start)) {
        const now = Date.now()
        const ms = (() => {
          const s = flags.start!.toLowerCase().replace(/\s+/g, '')
          const num = parseInt(s, 10)
          if (s.endsWith('m') || s.includes('min')) return num * 60_000
          if (s.endsWith('h') || s.includes('hour')) return num * 3_600_000
          if (s.endsWith('d') || s.includes('day')) return num * 86_400_000
          return 0
        })()
        startTimeParam = ['--start-time', String(now - ms)]
      } else {
        const t = Date.parse(flags.start)
        if (!Number.isNaN(t)) startTimeParam = ['--start-time', String(t)]
      }
    }

    // Determine stream if not provided: pick most recent by lastEventTimestamp
    const groupName = args.group
    let streamName = flags.stream

    if (!streamName) {
      const describeCmd = [
        'logs',
        'describe-log-streams',
        '--log-group-name',
        groupName,
        '--order-by',
        'LastEventTime',
        '--descending',
        '--max-items',
        '1',
        '--output',
        'json',
        ...baseAwsArgs,
      ]

      if (flags['dry-run']) {
        this.log('[dry-run] aws ' + describeCmd.join(' '))
        return
      }

      try {
        const {stdout} = await execFileAsync('aws', describeCmd)
        const data = JSON.parse(stdout)
        streamName = data?.logStreams?.[0]?.logStreamName
        if (!streamName) this.error('No log streams found for the specified group.')
      } catch (error: any) {
        const message = error?.stderr?.toString?.() || error?.message || String(error)
        this.error(`Failed to describe log streams. ${message}`)
      }
    }

    const eventsCmd = [
      'logs',
      'get-log-events',
      '--log-group-name',
      groupName,
      '--log-stream-name',
      streamName!,
      '--limit',
      String(flags.limit ?? 50),
      '--output',
      'json',
      ...startTimeParam,
      ...baseAwsArgs,
    ]

    if (flags['dry-run']) {
      this.log('[dry-run] aws ' + eventsCmd.join(' '))
      return
    }

    try {
      const {stdout} = await execFileAsync('aws', eventsCmd)
      if (flags.json) {
        this.log(stdout.trim())
        return
      }

      const data = JSON.parse(stdout)
      const events = data?.events ?? []
      for (const ev of events) {
        const ts = ev.timestamp ? new Date(ev.timestamp).toISOString() : ''
        this.log(`${ts} ${ev.message ?? ''}`.trimEnd())
      }
    } catch (error: any) {
      const message = error?.stderr?.toString?.() || error?.message || String(error)
      this.error(`Failed to get log events. ${message}`)
    }
  }
}


