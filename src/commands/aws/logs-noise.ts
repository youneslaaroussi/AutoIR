import {Args, Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'

const execFileAsync = promisify(execFile)

type Action = 'deploy' | 'status' | 'logs' | 'start' | 'stop' | 'destroy'

export default class LogsNoise extends Command {
  static args = {
    action: Args.string({
      description: 'Action to perform: deploy | status | logs | start | stop | destroy',
      required: true,
      options: ['deploy','status','logs','start','stop','destroy']
    })
  }

  static description = 'Deploy a tiny ECS service that writes random logs to CloudWatch for testing'

  static flags = {
    profile: Flags.string({description: 'AWS profile'}),
    region: Flags.string({description: 'AWS region'}),
    cluster: Flags.string({description: 'ECS cluster name', default: 'autoir'}),
    service: Flags.string({description: 'ECS service name', default: 'autoir-noise'}),
    stack: Flags.string({description: 'CloudFormation stack name', default: 'AutoIR-Noise'}),
    vpcId: Flags.string({description: 'VPC ID to run in (optional)'}),
    subnets: Flags.string({description: 'Comma-separated subnet IDs (required if vpcId provided)'}),
    securityGroups: Flags.string({description: 'Comma-separated security group IDs'}),
    desiredCount: Flags.integer({description: 'Service desired count', default: 1}),
    cpu: Flags.integer({description: 'Task CPU units', default: 256}),
    memory: Flags.integer({description: 'Task memory MB', default: 512}),
    logGroup: Flags.string({description: 'CloudWatch Logs log group', default: '/autoir/noise'}),
    rate: Flags.integer({description: 'Approx logs per second', default: 5}),
    errorRate: Flags.integer({description: 'Percentage of error-like logs (0-100)', default: 20}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(LogsNoise)
    const action = args.action as Action

    switch (action) {
      case 'deploy':
        await this.deploy(flags)
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
        await this.destroy(flags)
        break
    }
  }

  private buildTemplate(flags: any): string {
    const hasVpc = !!flags.vpcId
    const subnets = (flags.subnets || '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const sgs = (flags.securityGroups || '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const logGroup = flags.logGroup || '/autoir/noise'
    const rate = Math.max(1, Number(flags.rate || 5))
    const errPct = Math.min(100, Math.max(0, Number(flags.errorRate || 20)))

    const js = `const pick=a=>a[Math.random()*a.length|0];\nconst infos=[\n  'INFO startup OK',\n  'INFO user logged in',\n  'DEBUG cache miss',\n  'INFO processed request',\n  'DEBUG polling tick'\n];\nconst errs=[\n  'ERROR timeout contacting DB',\n  'ERROR unhandled exception in worker',\n  'ERROR upstream 502',\n  'ERROR deadlock detected',\n  'ERROR panic: nil pointer'\n];\nconst rate=${rate};\nconst errFrac=${(errPct/100).toFixed(3)};\nsetInterval(()=>{\n  const n=rate;\n  for(let i=0;i<n;i++){\n    const isErr=Math.random()<errFrac;\n    const msg=(isErr?pick(errs):pick(infos));\n    console.log(new Date().toISOString(), msg)\n  }\n},1000);`

    return JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'AutoIR noise generator service (ECS Fargate)',
      Resources: {
        LogGroup: {
          Type: 'AWS::Logs::LogGroup',
          Properties: { LogGroupName: logGroup, RetentionInDays: 1 }
        },
        TaskRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Principal: { Service: ['ecs-tasks.amazonaws.com'] }, Action: ['sts:AssumeRole'] }]
            }
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
            Cpu: String(flags.cpu || 256),
            Memory: String(flags.memory || 512),
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            ExecutionRoleArn: { 'Fn::GetAtt': ['ExecutionRole', 'Arn'] },
            TaskRoleArn: { 'Fn::GetAtt': ['TaskRole', 'Arn'] },
            ContainerDefinitions: [{
              Name: 'noise',
              Image: 'public.ecr.aws/docker/library/node:20-alpine',
              Command: ['node','-e', js],
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: {
                  'awslogs-group': { Ref: 'LogGroup' },
                  'awslogs-region': flags.region || '',
                  'awslogs-stream-prefix': 'noise'
                }
              },
            }]
          }
        },
        Service: {
          Type: 'AWS::ECS::Service',
          Properties: {
            Cluster: flags.cluster,
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
      Outputs: { LogGroupName: { Value: logGroup } }
    }, null, 2)
  }

  private async deploy(flags: any): Promise<void> {
    // If networking not provided, try to detect default VPC + subnets + default SG
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

    if (!flags.vpcId || !flags.subnets) {
      this.error('ECS Fargate requires VPC and Subnets. Provide --vpcId and --subnets (comma-separated), or ensure a default VPC exists in this region.')
      return
    }

    const templateBody = this.buildTemplate(flags)
    const {promises: fs} = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmpPath = path.join(os.tmpdir(), `autoir-noise-${Date.now()}.json`)
    await fs.writeFile(tmpPath, templateBody, 'utf8')

    const args = ['cloudformation','deploy','--stack-name', flags.stack, '--capabilities','CAPABILITY_NAMED_IAM','--template-file', tmpPath]
    if (flags.region) args.push('--region', flags.region)
    if (flags.profile) args.push('--profile', flags.profile)

    this.log(chalk.cyan(`Deploying noise stack '${flags.stack}'...`))
    await new Promise<void>(async (resolve, reject) => {
      const {spawn} = await import('node:child_process')
      const child = spawn('aws', args, {stdio: 'inherit'})
      child.on('close', async (code: number) => {
        try { await fs.unlink(tmpPath) } catch {}
        code === 0 ? resolve() : reject(new Error(`aws cloudformation deploy exited ${code}`))
      })
    })
  }

  private async destroy(flags: any): Promise<void> {
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

  private async updateDesiredCount(flags: any, desired: number): Promise<void> {
    const args = ['ecs','update-service','--cluster', flags.cluster, '--service', flags.service, '--desired-count', String(desired)]
    if (flags.region) args.push('--region', flags.region)
    if (flags.profile) args.push('--profile', flags.profile)
    const {stdout} = await execFileAsync('aws', args)
    this.log(stdout.trim())
  }

  private async showLogs(flags: any): Promise<void> {
    const logGroup = flags.logGroup || '/autoir/noise'
    const args = ['logs','tail', logGroup, '--follow', '--format','short']
    if (flags.region) args.unshift('--region', flags.region)
    if (flags.profile) args.unshift('--profile', flags.profile)
    const {spawn} = await import('node:child_process')
    const child = spawn('aws', args, {stdio: 'inherit'})
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  }
}
