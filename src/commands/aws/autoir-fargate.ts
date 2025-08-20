import {Args, Command, Flags} from '@oclif/core'
import {promisify} from 'node:util'
import {execFile, spawn} from 'node:child_process'
import chalk from 'chalk'
import mysql from 'mysql2/promise'
import {getTiDBProfile, parseMySqlDsn} from '../../lib/config.js'
import {ensureAutoIrTables} from '../../lib/db.js'

const execFileAsync = promisify(execFile)

type Action = 'deploy' | 'status' | 'logs' | 'start' | 'stop' | 'destroy'

export default class AutoirFargate extends Command {
  static args = {
    action: Args.string({
      description: 'Action to perform: deploy | status | logs | start | stop | destroy',
      required: true,
      options: ['deploy','status','logs','start','stop','destroy']
    })
  }

  static description = 'Manage AutoIR ECS Fargate deployment (deploy/status/logs/start/stop/destroy)'

  static examples = [
    '<%= config.bin %> <%= command.id %> deploy --cluster autoir --service autoir --region us-east-1',
    '<%= config.bin %> <%= command.id %> status --cluster autoir --service autoir',
    '<%= config.bin %> <%= command.id %> logs --cluster autoir --log-group /autoir/daemon',
  ]

  static flags = {
    profile: Flags.string({description: 'AWS profile'}),
    region: Flags.string({description: 'AWS region'}),
    cluster: Flags.string({description: 'ECS cluster name', default: 'autoir'}),
    service: Flags.string({description: 'ECS service name', default: 'autoir'}),
    stack: Flags.string({description: 'CloudFormation stack name', default: 'AutoIR-Fargate'}),
    image: Flags.string({description: 'Container image (ECR URI). If omitted, we build & push.'}),
    vpcId: Flags.string({description: 'VPC ID to run in (optional)'}),
    subnets: Flags.string({description: 'Comma-separated subnet IDs (required if vpcId provided)'}),
    securityGroups: Flags.string({description: 'Comma-separated security group IDs'}),
    cpu: Flags.integer({description: 'Task CPU units', default: 512}),
    memory: Flags.integer({description: 'Task memory MB', default: 1024}),
    desiredCount: Flags.integer({description: 'Service desired count', default: 1}),
    autoBuild: Flags.boolean({description: 'Build and push a container image automatically', default: true}),
    repo: Flags.string({description: 'ECR repository name for auto-build', default: 'autoir'}),
    tag: Flags.string({description: 'Image tag for auto-build', default: 'latest'}),
    dsn: Flags.string({description: 'TiDB DSN (overrides saved profile)'}),
    ensureTables: Flags.boolean({description: 'Ensure DB tables before deploy', default: true}),
    // Kebab-case aliases for UX
    logGroup: Flags.string({description: 'CloudWatch Logs log group for the daemon', default: '/autoir/daemon'}),
    'log-group': Flags.string({description: 'CloudWatch Logs log group for the daemon (alias)'}),
    sagemakerEndpoint: Flags.string({description: 'SageMaker endpoint for embeddings'}),
    'sagemaker-endpoint': Flags.string({description: 'SageMaker endpoint for embeddings (alias)'}),
    sagemakerRegion: Flags.string({description: 'SageMaker region'}),
    'sagemaker-region': Flags.string({description: 'SageMaker region (alias)'}),
    daemonLogGroups: Flags.string({description: 'Comma-separated CloudWatch log groups to watch'}),
    'daemon-log-groups': Flags.string({description: 'Comma-separated CloudWatch log groups to watch (alias)'}),
    // Alerting flags (passed as env to the daemon)
    alertsEnabled: Flags.boolean({description: 'Enable LLM-based alerting loop', default: false}),
    alertsIntervalSec: Flags.integer({description: 'Alerting interval (seconds)', default: 300}),
    alertsWindowMin: Flags.integer({description: 'Window of logs to analyze (minutes)', default: 10}),
    alertsMinConfidence: Flags.integer({description: 'Minimum confidence (0-100) to notify', default: 60}),
    alertsMinSeverity: Flags.string({description: 'Minimum severity to notify', options: ['info','low','medium','high','critical'], default: 'medium'}),
    alertsChannels: Flags.string({description: 'Comma-separated alert channels: slack,sns'}),
    slackWebhookUrl: Flags.string({description: 'Slack webhook URL for alerts'}),
    snsTopicArn: Flags.string({description: 'SNS Topic ARN for alerts'}),
    alertsMaxEvents: Flags.integer({description: 'Max events to scan per tick', default: 1000}),
    alertsMaxSamplesPerIssue: Flags.integer({description: 'Max sample messages per detected issue', default: 5}),
    alertsLogsTable: Flags.string({description: 'Override logs table name for alerting (default autoir_log_events)'}),
    localRun: Flags.boolean({description: 'Run the daemon locally instead of deploying (uses Docker image or local Node). Skips CloudFormation.', default: false}),
    alertsDryRun: Flags.boolean({description: 'Do not send notifications (channels ignored). For localRun testing.' , default: false}),
    // Kebab-case aliases for UX
    'alerts-dry-run': Flags.boolean({description: 'Alias of --alertsDryRun'}),
    'local-run': Flags.boolean({description: 'Alias of --localRun'}),
    'alerts-enabled': Flags.boolean({description: 'Alias of --alertsEnabled'}),
    'alerts-interval-sec': Flags.integer({description: 'Alias of --alertsIntervalSec'}),
    'alerts-window-min': Flags.integer({description: 'Alias of --alertsWindowMin'}),
    'alerts-min-confidence': Flags.integer({description: 'Alias of --alertsMinConfidence'}),
    'alerts-min-severity': Flags.string({description: 'Alias of --alertsMinSeverity', options: ['info','low','medium','high','critical']}),
    'alerts-channels': Flags.string({description: 'Alias of --alertsChannels'}),
    'alerts-max-events': Flags.integer({description: 'Alias of --alertsMaxEvents'}),
    'alerts-max-samples-per-issue': Flags.integer({description: 'Alias of --alertsMaxSamplesPerIssue'}),
    'alerts-logs-table': Flags.string({description: 'Alias of --alertsLogsTable'}),
    'slack-webhook-url': Flags.string({description: 'Alias of --slackWebhookUrl'}),
    'sns-topic-arn': Flags.string({description: 'Alias of --snsTopicArn'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AutoirFargate)
    const action = args.action as Action

    if (flags.ensureTables && ['deploy','start'].includes(action)) {
      await this.ensureTables(flags)
    }

    switch (action) {
      case 'deploy':
        if (flags.localRun || flags['local-run']) {
          await this.runLocalDaemon(flags)
        } else {
          await this.deployStack(flags)
        }
        break
      case 'status':
        await this.status(flags)
        break
      case 'logs':
        await this.showLogs(flags)
        break
      case 'start':
        await this.updateDesiredCount(flags, flags.desiredCount ?? 1)
        break
      case 'stop':
        await this.updateDesiredCount(flags, 0)
        break
      case 'destroy':
        await this.destroyStack(flags)
        break
    }
  }

  private async runLocalDaemon(flags: any): Promise<void> {
    this.log(chalk.cyan('Starting daemon locally (no CloudFormation deploy)...'))
    // Ensure tables (optional)
    if (flags.ensureTables !== false) {
      await this.ensureTables(flags)
    }

    const daemonGroups = flags.daemonLogGroups || flags['daemon-log-groups'] || process.env.LOG_GROUPS || ''
    const smEndpoint = flags.sagemakerEndpoint || flags['sagemaker-endpoint'] || process.env.SAGEMAKER_ENDPOINT || ''
    const smRegion = flags.sagemakerRegion || flags['sagemaker-region'] || flags.region || process.env.SAGEMAKER_REGION || ''

    if (!daemonGroups) this.warn('No log groups provided (use --daemon-log-groups). The daemon will exit early.')
    if (!smEndpoint) this.warn('No sagemaker endpoint provided (use --sagemaker-endpoint). The daemon will exit early.')

    // Normalize alert flags with kebab-case aliases
    const effAlertsEnabled = !!(flags.alertsEnabled || flags['alerts-enabled'] || /^true$/i.test(process.env.ALERTS_ENABLED || ''))
    const effInterval = flags.alertsIntervalSec ?? flags['alerts-interval-sec'] ?? process.env.ALERTS_INTERVAL_SEC ?? 300
    const effWindow = flags.alertsWindowMin ?? flags['alerts-window-min'] ?? process.env.ALERTS_WINDOW_MINUTES ?? 10
    const effMinConf = flags.alertsMinConfidence ?? flags['alerts-min-confidence'] ?? process.env.ALERTS_MIN_CONFIDENCE ?? 60
    const effMinSev = flags.alertsMinSeverity ?? flags['alerts-min-severity'] ?? process.env.ALERTS_MIN_SEVERITY ?? 'medium'
    const effChannels = (flags.alertsDryRun || flags['alerts-dry-run']) ? '' : (flags.alertsChannels ?? flags['alerts-channels'] ?? process.env.ALERTS_CHANNELS ?? '')
    const effSlack = (flags.alertsDryRun || flags['alerts-dry-run']) ? '' : (flags.slackWebhookUrl ?? flags['slack-webhook-url'] ?? process.env.SLACK_WEBHOOK_URL ?? '')
    const effSns = (flags.alertsDryRun || flags['alerts-dry-run']) ? '' : (flags.snsTopicArn ?? flags['sns-topic-arn'] ?? process.env.SNS_TOPIC_ARN ?? '')
    const effMaxEvents = flags.alertsMaxEvents ?? flags['alerts-max-events'] ?? process.env.ALERTS_MAX_EVENTS ?? 1000
    const effMaxSamples = flags.alertsMaxSamplesPerIssue ?? flags['alerts-max-samples-per-issue'] ?? process.env.ALERTS_MAX_SAMPLES_PER_ISSUE ?? 5
    const effLogsTable = flags.alertsLogsTable ?? flags['alerts-logs-table'] ?? process.env.ALERTS_LOGS_TABLE ?? ''

    const alertsEnv = {
      ALERTS_ENABLED: effAlertsEnabled ? 'true' : 'false',
      ALERTS_INTERVAL_SEC: String(effInterval),
      ALERTS_WINDOW_MINUTES: String(effWindow),
      ALERTS_MIN_CONFIDENCE: String(effMinConf),
      ALERTS_MIN_SEVERITY: String(effMinSev),
      ALERTS_CHANNELS: String(effChannels),
      SLACK_WEBHOOK_URL: String(effSlack),
      SNS_TOPIC_ARN: String(effSns),
      ALERTS_MAX_EVENTS: String(effMaxEvents),
      ALERTS_MAX_SAMPLES_PER_ISSUE: String(effMaxSamples),
      ALERTS_LOGS_TABLE: String(effLogsTable),
    }

    // Resolve DSN: flag -> env -> saved profile
    let dsnVal: string = flags.dsn || process.env.TIDB_DSN || ''
    if (!dsnVal) {
      try {
        const saved = await getTiDBProfile('default')
        if (saved?.host && saved?.user && saved?.database) {
          const auth = saved.password ? `${encodeURIComponent(saved.user)}:${encodeURIComponent(saved.password)}` : encodeURIComponent(saved.user)
          const port = saved.port ? `:${saved.port}` : ''
          dsnVal = `mysql://${auth}@${saved.host}${port}/${saved.database}`
        }
      } catch {}
    }

    const env = {
      ...process.env,
      LOG_GROUPS: daemonGroups,
      AWS_REGION: flags.region || process.env.AWS_REGION || '',
      SAGEMAKER_ENDPOINT: smEndpoint,
      SAGEMAKER_REGION: smRegion,
      TIDB_DSN: dsnVal,
      ...alertsEnv,
    }

    const child = spawn(process.execPath, ['./bin/run.js','daemon'], { stdio: 'inherit', env })
    await new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`daemon exited with code ${code}`)))
      child.on('error', (e) => reject(e))
    })
  }

  private async ensureTables(flags: any): Promise<void> {
    const viaDsn = flags.dsn ? parseMySqlDsn(flags.dsn) : undefined
    const saved = await getTiDBProfile('default')
    const conn = viaDsn ?? saved
    if (!conn) { this.warn('No TiDB connection available to ensure tables'); return }

    const pool = mysql.createPool({
      host: conn.host,
      port: conn.port ?? 4000,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      waitForConnections: true,
      connectionLimit: 5,
      ...( /tidbcloud\.com$/i.test(conn.host) ? {ssl: {minVersion: 'TLSv1.2', rejectUnauthorized: true}} : {}),
    })
    try {
      await ensureAutoIrTables(pool)
      this.log('Ensured AutoIR tables in TiDB')
    } finally {
      await pool.end()
    }
  }

  private buildCfnTemplate(flags: any): string {
    const hasVpc = !!flags.vpcId
    const subnets = (flags.subnets || '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const sgs = (flags.securityGroups || '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const logGroup = flags.logGroup || flags['log-group'] || '/autoir/daemon'
    const daemonGroups = flags.daemonLogGroups || flags['daemon-log-groups'] || ''
    const smEndpoint = flags.sagemakerEndpoint || flags['sagemaker-endpoint'] || ''
    const smRegion = flags.sagemakerRegion || flags['sagemaker-region'] || flags.region || ''
    const clusterExists = !!flags._clusterExists
    const alertsEnabled = !!(flags.alertsEnabled || flags['alerts-enabled'])
    const alertsIntervalSec = flags.alertsIntervalSec ?? flags['alerts-interval-sec'] ?? 300
    const alertsWindowMin = flags.alertsWindowMin ?? flags['alerts-window-min'] ?? 10
    const alertsMinConfidence = flags.alertsMinConfidence ?? flags['alerts-min-confidence'] ?? 60
    const alertsMinSeverity = flags.alertsMinSeverity ?? flags['alerts-min-severity'] ?? 'medium'
    const alertsChannels = flags.alertsChannels ?? flags['alerts-channels'] ?? ''
    const slackWebhookUrl = flags.slackWebhookUrl ?? flags['slack-webhook-url'] ?? ''
    const snsTopicArn = flags.snsTopicArn ?? flags['sns-topic-arn'] ?? ''
    const alertsMaxEvents = flags.alertsMaxEvents ?? flags['alerts-max-events'] ?? 1000
    const alertsMaxSamplesPerIssue = flags.alertsMaxSamplesPerIssue ?? flags['alerts-max-samples-per-issue'] ?? 5
    const alertsLogsTable = flags.alertsLogsTable ?? flags['alerts-logs-table'] ?? ''
    const alertsEnv = [
      { Name: 'ALERTS_ENABLED', Value: alertsEnabled ? 'true' : 'false' },
      { Name: 'ALERTS_INTERVAL_SEC', Value: String(alertsIntervalSec) },
      { Name: 'ALERTS_WINDOW_MINUTES', Value: String(alertsWindowMin) },
      { Name: 'ALERTS_MIN_CONFIDENCE', Value: String(alertsMinConfidence) },
      { Name: 'ALERTS_MIN_SEVERITY', Value: String(alertsMinSeverity) },
      { Name: 'ALERTS_CHANNELS', Value: String(alertsChannels) },
      { Name: 'SLACK_WEBHOOK_URL', Value: String(slackWebhookUrl) },
      { Name: 'SNS_TOPIC_ARN', Value: String(snsTopicArn) },
      { Name: 'ALERTS_MAX_EVENTS', Value: String(alertsMaxEvents) },
      { Name: 'ALERTS_MAX_SAMPLES_PER_ISSUE', Value: String(alertsMaxSamplesPerIssue) },
      { Name: 'ALERTS_LOGS_TABLE', Value: String(alertsLogsTable) },
    ]

    return JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'AutoIR Fargate deployment',
      Resources: {
        ...(clusterExists ? {} : { Cluster: { Type: 'AWS::ECS::Cluster', Properties: { ClusterName: flags.cluster } } }),
        TaskRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Principal: { Service: ['ecs-tasks.amazonaws.com'] }, Action: ['sts:AssumeRole'] }]
            },
            Policies: [{
              PolicyName: 'autoir-task-policy',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  { Effect: 'Allow', Action: ['logs:CreateLogStream','logs:PutLogEvents'], Resource: '*' },
                  { Effect: 'Allow', Action: ['logs:DescribeLogGroups','logs:DescribeLogStreams','logs:FilterLogEvents'], Resource: '*' },
                  { Effect: 'Allow', Action: ['sagemaker:InvokeEndpoint'], Resource: '*' },
                  ...(flags.snsTopicArn ? [{ Effect: 'Allow', Action: ['sns:Publish'], Resource: flags.snsTopicArn }] : [])
                ]
              }
            }]
          }
        },
        ExecutionRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Principal: { Service: ['ecs-tasks.amazonaws.com'] }, Action: ['sts:AssumeRole'] }]
            },
            ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']
          }
        },
        TaskDefinition: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Cpu: String(flags.cpu || 512),
            Memory: String(flags.memory || 1024),
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            ExecutionRoleArn: { 'Fn::GetAtt': ['ExecutionRole', 'Arn'] },
            TaskRoleArn: { 'Fn::GetAtt': ['TaskRole', 'Arn'] },
            ContainerDefinitions: [{
              Name: 'autoir',
              Image: flags.image || 'public.ecr.aws/docker/library/node:20-alpine',
              Command: ['node','/app/bin/run.js','daemon'],
              Environment: [
                { Name: 'LOG_GROUPS', Value: daemonGroups },
                { Name: 'AWS_REGION', Value: flags.region || '' },
                { Name: 'SAGEMAKER_ENDPOINT', Value: smEndpoint },
                { Name: 'SAGEMAKER_REGION', Value: smRegion },
                { Name: 'TIDB_DSN', Value: flags.dsn || '' },
                ...alertsEnv
              ],
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: {
                  'awslogs-group': logGroup,
                  'awslogs-region': flags.region || '',
                  'awslogs-stream-prefix': 'autoir'
                }
              },
              PortMappings: []
            }]
          }
        },
        Service: {
          Type: 'AWS::ECS::Service',
          DependsOn: clusterExists ? ['TaskDefinition'] : ['Cluster','TaskDefinition'],
          Properties: {
            Cluster: clusterExists ? flags.cluster : { Ref: 'Cluster' },
            DesiredCount: flags.desiredCount ?? 1,
            LaunchType: 'FARGATE',
            TaskDefinition: { Ref: 'TaskDefinition' },
            NetworkConfiguration: hasVpc ? {
              AwsvpcConfiguration: {
                AssignPublicIp: 'ENABLED',
                Subnets: subnets,
                SecurityGroups: sgs
              }
            } : { Ref: 'AWS::NoValue' }
          }
        }
      },
      Outputs: {
        ClusterName: { Value: clusterExists ? flags.cluster : { Ref: 'Cluster' } },
        ServiceName: { Value: { Ref: 'Service' } }
      }
    }, null, 2)
  }

  private async deployStack(flags: any): Promise<void> {
    // Ensure an image exists; build and push if not provided
    if (!flags.image && flags.autoBuild) {
      this.log(chalk.cyan('Building and pushing container image (autoBuild enabled)...'))
      flags.image = await this.buildAndPushImage(flags)
      this.log(chalk.green(`Image ready: ${flags.image}`))
    }
    if (!flags.image) {
      this.error('No image provided. Either pass --image or enable --autoBuild to build and push automatically.')
      return
    }

    // Ensure VPC + Subnets present; if missing, try to auto-detect default VPC
    if (!flags.vpcId || !flags.subnets) {
      this.log(chalk.cyan('Discovering default VPC/subnets...'))
      try {
        const discoverArgs = ['ec2','describe-vpcs','--filters','Name=isDefault,Values=true','--output','json']
        if (flags.region) discoverArgs.unshift('--region', flags.region)
        if (flags.profile) discoverArgs.unshift('--profile', flags.profile)
        const {stdout: vpcsOut} = await execFileAsync('aws', discoverArgs)
        const vpcs = JSON.parse(vpcsOut).Vpcs || []
        const vpcId = vpcs[0]?.VpcId
        if (vpcId) {
          const subArgs = ['ec2','describe-subnets','--filters',`Name=vpc-id,Values=${vpcId}`,'--output','json']
          if (flags.region) subArgs.unshift('--region', flags.region)
          if (flags.profile) subArgs.unshift('--profile', flags.profile)
          const {stdout: subsOut} = await execFileAsync('aws', subArgs)
          const subs = JSON.parse(subsOut).Subnets || []
          const subnetIds = subs.map((s: any) => s.SubnetId).slice(0, 3)
          if (subnetIds.length) {
            flags.vpcId = vpcId
            flags.subnets = subnetIds.join(',')
          }

          // Also try to discover the default security group for the VPC if none provided
          if (!flags.securityGroups) {
            const sgArgs = ['ec2','describe-security-groups','--filters',`Name=vpc-id,Values=${vpcId}`, 'Name=group-name,Values=default','--output','json']
            if (flags.region) sgArgs.unshift('--region', flags.region)
            if (flags.profile) sgArgs.unshift('--profile', flags.profile)
            try {
              const {stdout: sgsOut} = await execFileAsync('aws', sgArgs)
              const sgs = JSON.parse(sgsOut).SecurityGroups || []
              const sgId = sgs[0]?.GroupId
              if (sgId) flags.securityGroups = sgId
            } catch {}
          }
        }
      } catch {}
    }

    // Detect if cluster exists already to avoid duplicate creation
    try {
      this.log(chalk.cyan(`Checking if ECS cluster '${flags.cluster}' exists...`))
      const args = ['ecs','describe-clusters','--clusters', flags.cluster, '--output','json']
      if (flags.region) args.unshift('--region', flags.region)
      if (flags.profile) args.unshift('--profile', flags.profile)
      const {stdout} = await execFileAsync('aws', args)
      const result = JSON.parse(stdout)
      if (result.clusters && result.clusters.length > 0 && result.clusters[0].status === 'ACTIVE') {
        ;(flags as any)._clusterExists = true
        this.log(chalk.gray(`Cluster exists: ${flags.cluster}`))
      } else {
        this.log(chalk.yellow(`Cluster '${flags.cluster}' does not exist, will create it`))
      }
    } catch (error) {
      this.log(chalk.yellow(`Could not check cluster status, will attempt to create: ${error}`))
    }

    if (!flags.vpcId || !flags.subnets) {
      this.error('ECS Fargate requires VPC and Subnets. Provide --vpcId and --subnets (comma-separated), or ensure a default VPC exists in this region.')
      return
    }

    // If no DSN flag, try to source from saved profile and inject into task env
    if (!flags.dsn) {
      try {
        const saved = await getTiDBProfile('default')
        if (saved?.host && saved?.user && saved?.database) {
          const auth = saved.password ? `${encodeURIComponent(saved.user)}:${encodeURIComponent(saved.password)}` : encodeURIComponent(saved.user)
          const port = saved.port ? `:${saved.port}` : ''
          flags.dsn = `mysql://${auth}@${saved.host}${port}/${saved.database}`
        }
      } catch {}
    }

    const templateBody = this.buildCfnTemplate(flags)
    // Write template to a temp file because `deploy` does not accept stdin
    const {promises: fs} = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmpPath = path.join(os.tmpdir(), `autoir-fargate-${Date.now()}.json`)
    await fs.writeFile(tmpPath, templateBody, 'utf8')

    const args = ['cloudformation','deploy','--stack-name', flags.stack, '--capabilities','CAPABILITY_NAMED_IAM','--template-file', tmpPath]
    if (flags.region) args.push('--region', flags.region)
    if (flags.profile) args.push('--profile', flags.profile)

    const {spawn} = await import('node:child_process')
    this.log(chalk.cyan(`Deploying CloudFormation stack '${flags.stack}'...`))
    return await new Promise<void>((resolve, reject) => {
      const child = spawn('aws', args, {stdio: ['inherit','inherit','inherit']})
      child.on('close', async (code) => {
        try { await fs.unlink(tmpPath) } catch {}
        code === 0 ? resolve() : reject(new Error(`aws cloudformation deploy exited ${code}`))
      })
    })
  }

  private async buildAndPushImage(flags: any): Promise<string> {
    // Basic prereq checks
    try { await execFileAsync('docker', ['version']) } catch {
      throw new Error('Docker is required to build the container image. Please install and start Docker.')
    }

    const region = flags.region
    if (!region) throw new Error('Provide --region to build and push image')

    // Account ID for ECR
    const stsArgs = ['sts','get-caller-identity','--output','json']
    if (flags.region) stsArgs.unshift('--region', flags.region)
    if (flags.profile) stsArgs.unshift('--profile', flags.profile)
    const {stdout: idOut} = await execFileAsync('aws', stsArgs)
    const acct = JSON.parse(idOut).Account
    if (!acct) throw new Error('Failed to resolve AWS account for ECR')

    const repo = flags.repo || 'autoir'
    const repoUri = `${acct}.dkr.ecr.${region}.amazonaws.com/${repo}`

    // Ensure ECR repository
    this.log(chalk.cyan(`Ensuring ECR repository '${repo}' in ${region}...`))
    const ensureArgs = ['ecr','describe-repositories','--repository-names', repo]
    if (flags.region) ensureArgs.unshift('--region', flags.region)
    if (flags.profile) ensureArgs.unshift('--profile', flags.profile)
    try { await execFileAsync('aws', ensureArgs) } catch {
      const createArgs = ['ecr','create-repository','--repository-name', repo]
      if (flags.region) createArgs.unshift('--region', flags.region)
      if (flags.profile) createArgs.unshift('--profile', flags.profile)
      await this.runStream('aws', createArgs)
    }

    // ECR login
    this.log(chalk.cyan('Logging in to ECR...'))
    const loginArgs = ['ecr','get-login-password']
    if (flags.region) loginArgs.unshift('--region', flags.region)
    if (flags.profile) loginArgs.unshift('--profile', flags.profile)
    const {stdout: pw} = await execFileAsync('aws', loginArgs)
    await this.runStream('bash', ['-lc', `echo "$PW" | docker login --username AWS --password-stdin ${repoUri.split('/')[0]}`], {...process.env, PW: pw.trim()})

    // Build context: ensure Dockerfile. If absent, build using a generated minimal Dockerfile in a temp dir
    const tag = flags.tag || 'latest'
    const imageUri = `${repoUri}:${tag}`
    const {promises: fs} = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    let buildDir = process.cwd()
    let cleanup = false
    try {
      await fs.access(path.join(buildDir, 'Dockerfile'))
    } catch {
      // Create temp build dir
      buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoir-build-'))
      cleanup = true
      const dockerfile = `# Auto-generated minimal image for AutoIR daemon\n\
FROM node:20-bookworm\n\
WORKDIR /app\n\
COPY . .\n\
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm build\n\
CMD [\"node\", \"/app/bin/run.js\", \"daemon\"]\n`
      await fs.writeFile(path.join(buildDir, 'Dockerfile'), dockerfile, 'utf8')
      // Create minimal package manifest to run daemon in container
      await fs.writeFile(path.join(buildDir, '.dockerignore'), 'node_modules\n.git\ndist\n', 'utf8')
      // Copy project files into buildDir via tar piping to avoid large copies from WSL
      await execFileAsync('bash', ['-lc', `tar -C . -cf - . | tar -C '${buildDir.replace(/'/g, "'\\''")}' -xf -`])
    }

    this.log(chalk.cyan(`Building Docker image ${imageUri} ...`))
    await this.runStream('docker', ['build','-t', imageUri, buildDir])
    try { if (cleanup) await fs.rm(buildDir, {recursive: true, force: true}) } catch {}
    this.log(chalk.cyan(`Pushing ${imageUri} ...`))
    await this.runStream('docker', ['push', imageUri])
    return imageUri
  }

  private async runStream(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    const {spawn} = await import('node:child_process')
    return await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {stdio: 'inherit', env: env ?? process.env})
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
    })
  }

  private async destroyStack(flags: any): Promise<void> {
    const args = ['cloudformation','delete-stack','--stack-name', flags.stack]
    if (flags.region) args.push('--region', flags.region)
    if (flags.profile) args.push('--profile', flags.profile)
    await execFileAsync('aws', args)
    this.log(`Delete requested for stack ${flags.stack}`)
  }

  private async status(flags: any): Promise<void> {
    const args = ['ecs','describe-services','--cluster', flags.cluster, '--services', flags.service]
    if (flags.region) args.push('--region', flags.region)
    if (flags.profile) args.push('--profile', flags.profile)
    const {stdout} = await execFileAsync('aws', args)
    this.log(stdout.trim())
  }

  private async showLogs(flags: any): Promise<void> {
    const logGroup = flags.logGroup || '/autoir/daemon'
    const args = ['logs','tail', logGroup, '--follow', '--format','short']
    if (flags.region) args.unshift('--region', flags.region)
    if (flags.profile) args.unshift('--profile', flags.profile)
    const {spawn} = await import('node:child_process')
    const child = spawn('aws', args, {stdio: 'inherit'})
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  }

  private async updateDesiredCount(flags: any, desired: number): Promise<void> {
    const args = ['ecs','update-service','--cluster', flags.cluster, '--service', flags.service, '--desired-count', String(desired)]
    if (flags.region) args.push('--region', flags.region)
    if (flags.profile) args.push('--profile', flags.profile)
    const {stdout} = await execFileAsync('aws', args)
    this.log(stdout.trim())
  }
}
