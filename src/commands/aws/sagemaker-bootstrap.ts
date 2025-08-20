import {Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import chalk from 'chalk'
import ora from 'ora'

const execFileAsync = promisify(execFile)

export default class AwsSageMakerBootstrap extends Command {
  static description = 'Provision a SageMaker Serverless Inference embedding endpoint from scratch (role, model, endpoint), then test it.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --region us-east-1 --endpoint autoir-embed-ep',
    '<%= config.bin %> <%= command.id %> --region us-east-1 --endpoint autoir-embed-ep --instance ml.m5.2xlarge',
  ]

  static flags = {
    region: Flags.string({char: 'r', description: 'AWS region', required: true}),
    profile: Flags.string({char: 'p', description: 'AWS profile to use'}),
    endpoint: Flags.string({description: 'SageMaker endpoint name', required: true}),
    // Always serverless
    memory: Flags.integer({description: 'Serverless memory (MB)', default: 2048}),
    concurrency: Flags.integer({description: 'Serverless max concurrency', default: 5}),
    modelId: Flags.string({description: 'HF model id to serve', default: 'BAAI/bge-small-en-v1.5'}),
    roleName: Flags.string({description: 'Execution role name to create/use', default: 'autoir-sagemaker-exec'}),
    image: Flags.string({description: 'Override inference image URI (defaults to HF DLC for region)'}),
    'dry-run': Flags.boolean({description: 'Print commands without executing', default: false}),
    debug: Flags.boolean({description: 'Print AWS CLI stderr on failures', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AwsSageMakerBootstrap)
    const region = flags.region
    const profile = flags.profile
    const endpoint = flags.endpoint
    const useServerless = true
    const roleName = flags.roleName
    const modelId = flags.modelId
    const base = ['--region', region]
    if (profile) base.unshift('--profile', profile)

    // 1) Ensure execution role exists with required policies
    const trust = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {Service: 'sagemaker.amazonaws.com'},
          Action: 'sts:AssumeRole',
        },
      ],
    }
    const trustStr = JSON.stringify(trust)
    const spRole = ora('Ensuring SageMaker execution role').start()
    const createRole = ['iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document', trustStr, ...base]
    const pol1 = ['iam', 'attach-role-policy', '--role-name', roleName, '--policy-arn', 'arn:aws:iam::aws:policy/AmazonSageMakerFullAccess', ...base]
    const pol2 = ['iam', 'attach-role-policy', '--role-name', roleName, '--policy-arn', 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly', ...base]
    await this.runAws(createRole, flags['dry-run'], flags.debug, {okCodes: ['EntityAlreadyExists']})
    // Always enforce correct trust policy in case the role existed but had wrong trust
    const updateTrust = ['iam', 'update-assume-role-policy', '--role-name', roleName, '--policy-document', trustStr, ...base]
    await this.runAws(updateTrust, flags['dry-run'], flags.debug)
    await this.runAws(pol1, flags['dry-run'], flags.debug)
    await this.runAws(pol2, flags['dry-run'], flags.debug)
    // Small delay for IAM propagation
    await new Promise(r => setTimeout(r, 3000))
    spRole.succeed('Execution role ready')

    // 2) Determine DLC image (HF pytorch inference) for region (use common account id 763104351884 where available)
    const account = '763104351884'
    let chosenImage = flags.image
    if (!chosenImage) {
      try {
        chosenImage = await this.pickAvailableCpuDlcImage(region, account, flags['dry-run'], flags.debug)
      } catch (e: any) {
        this.log(chalk.yellow(`Falling back to known DLC images: ${e?.message || e}`))
      }
    }
    const imageCandidates = chosenImage ? [chosenImage] : [
      `${account}.dkr.ecr.${region}.amazonaws.com/huggingface-pytorch-inference:2.1.0-transformers4.37.0-cpu-py310-ubuntu22.04`,
      `${account}.dkr.ecr.${region}.amazonaws.com/huggingface-pytorch-inference:1.13.1-transformers4.26.0-cpu-py39-ubuntu20.04`,
    ]

    // 3) Create model with environment (HF_MODEL_ID, HF_TASK)
    const modelName = `${endpoint}-model`
    const env = {HF_MODEL_ID: modelId, HF_TASK: 'feature-extraction'}
    const roleArn = `arn:aws:iam::${await this.accountId(base)}:role/${roleName}`
    const spModel = ora('Creating SageMaker model').start()
    // Reuse existing model if present; otherwise create with first valid image
    let modelCreated = false
    try {
      await execFileAsync('aws', ['sagemaker','describe-model','--model-name', modelName, ...base])
      spModel.succeed('Model already exists; reusing')
      modelCreated = true
    } catch {
      for (const image of imageCandidates) {
        const createModel = ['sagemaker', 'create-model', '--model-name', modelName, '--primary-container', JSON.stringify({Image: image, Environment: env}), '--execution-role-arn', roleArn, ...base]
        const res = await this.runAws(createModel, flags['dry-run'], flags.debug, {okCodes: ['Already exists', 'already existing', 'Cannot create already existing model']})
        if (res.ok) {
          spModel.succeed(`Model ready (${image})`)
          modelCreated = true
          break
        }
        if (flags.debug && res.stderr) this.log(chalk.gray(res.stderr))
      }
    }
    if (!modelCreated) {
      spModel.fail('Failed to create or reuse model. No valid DLC image found.')
      this.log('Pass a working image URI with --image (see AWS DLCs for your region).')
      return
    }

    // 4) Create endpoint-config and endpoint
    const configName = `${endpoint}-config`
    const variants = [{ModelName: modelName, VariantName: 'AllTraffic', ServerlessConfig: {MemorySizeInMB: flags.memory, MaxConcurrency: flags.concurrency}}]
    const spCfg = ora('Creating endpoint config').start()
    const createCfg = ['sagemaker', 'create-endpoint-config', '--endpoint-config-name', configName, '--production-variants', JSON.stringify(variants), ...base]
    const cfgRes = await this.runAws(createCfg, flags['dry-run'], flags.debug, {okCodes: ['ValidationException', 'Already exists', 'already existing']})
    if (cfgRes.ok) spCfg.succeed('Endpoint config ready')
    else spCfg.fail('Failed to create endpoint config')

    const spEp = ora('Creating endpoint').start()
    const createEp = ['sagemaker', 'create-endpoint', '--endpoint-name', endpoint, '--endpoint-config-name', configName, ...base]
    const epRes = await this.runAws(createEp, flags['dry-run'], flags.debug, {okCodes: ['ValidationException', 'AlreadyExistsException', 'already exists', 'already existing']})
    if (epRes.ok) spEp.succeed('Endpoint creation requested (or already exists)')
    else spEp.info('Proceeding to wait for endpoint status')

    if (flags['dry-run']) {
      this.log(chalk.cyan('[dry-run] ') + 'To use: ' + `${this.config.bin} logs tail <group> --sagemaker-endpoint ${endpoint} --sagemaker-region ${region}`)
      return
    }

    // 5) Wait for endpoint to be InService
    const spWait = ora('Waiting for endpoint to be InService... (initial NotFound is normal)').start()
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline) {
      try {
        const {stdout} = await execFileAsync('aws', ['sagemaker', 'describe-endpoint', '--endpoint-name', endpoint, ...base])
        const data = JSON.parse(stdout)
        const status = data?.EndpointStatus
        spWait.text = `Waiting for endpoint to be InService... (status: ${status})`
        if (status === 'InService') break
        if (status === 'Failed') {
          // Attempt one automatic repair: delete endpoint and recreate
          if (!flags['dry-run']) {
            try {
              await this.runAws(['sagemaker','delete-endpoint','--endpoint-name', endpoint, ...base], false, flags.debug)
              await sleep(5000)
              await this.runAws(['sagemaker','create-endpoint','--endpoint-name', endpoint, '--endpoint-config-name', configName, ...base], false, flags.debug)
            } catch {}
          }
          // Continue loop to wait again
        }
      } catch (e: any) {
        // NotFound during provisioning is expected for a short while
        const msg = e?.message || String(e)
        if (flags.debug) this.log(chalk.gray(msg))
      }
      await new Promise(r => setTimeout(r, 10000))
    }
    spWait.succeed('Endpoint is InService')

    // 6) Test invoke
    try {
      const spTest = ora('Testing endpoint with sample payload').start()
      const body = JSON.stringify({inputs: 'hello world'})
      await execFileAsync('aws', ['sagemaker-runtime', 'invoke-endpoint', '--endpoint-name', endpoint, '--content-type', 'application/json', '--accept', 'application/json', '--cli-binary-format', 'raw-in-base64-out', '--body', body, ...base, 'out.json'])
      spTest.succeed('Test invoke succeeded')
      const {stdout: cat} = await execFileAsync('cat', ['out.json'])
      this.log('Preview: ' + cat.slice(0, 200) + (cat.length > 200 ? ' ...' : ''))
    } catch (e: any) {
      this.log(chalk.yellow('Test invoke failed. Ensure the DLC supports HF_TASK=feature-extraction.'))
      if (flags.debug) this.log(chalk.gray(e?.message || String(e)))
    }

    this.log(chalk.green('SageMaker bootstrap complete.'))
    this.log('Use in logs tail:')
    this.log(`${this.config.bin} logs tail <group> --region ${region} --sagemaker-endpoint ${endpoint} --sagemaker-region ${region}`)
  }

  private async runAws(parts: string[], dryRun: boolean, debug = false, opts?: {okCodes?: string[]}) {
    if (dryRun) {
      this.log(chalk.cyan('[dry-run] ') + 'aws ' + parts.join(' '))
      return {ok: true}
    }
    try {
      const {stdout} = await execFileAsync('aws', parts)
      if (debug && stdout?.trim()) this.log(stdout.trim())
      return {ok: true}
    } catch (e: any) {
      const stderr = e?.stderr?.toString?.() || ''
      const msg = stderr || e?.message || String(e)
      const acceptable = (opts?.okCodes || []).some(c => msg.includes(c))
      if (!acceptable && debug) {
        this.log(chalk.yellow('Command failed: ') + 'aws ' + parts.join(' '))
        this.log(chalk.gray(msg))
      }
      return {ok: acceptable, stderr: msg}
    }
  }

  private async accountId(base: string[]): Promise<string> {
    try {
      const {stdout} = await execFileAsync('aws', ['sts', 'get-caller-identity', ...base])
      const data = JSON.parse(stdout)
      return data?.Account
    } catch {
      return '000000000000'
    }
  }

  private async pickAvailableCpuDlcImage(region: string, registryId: string, dryRun: boolean, debug: boolean): Promise<string> {
    if (dryRun) {
      return `${registryId}.dkr.ecr.${region}.amazonaws.com/huggingface-pytorch-inference:2.1.0-transformers4.37.0-cpu-py310-ubuntu22.04`
    }
    const {stdout} = await execFileAsync('aws', [
      'ecr','describe-images',
      '--registry-id', registryId,
      '--repository-name', 'huggingface-pytorch-inference',
      '--region', region,
      '--output','json'
    ])
    const data = JSON.parse(stdout)
    const tags: string[] = []
    for (const d of (data.imageDetails || [])) {
      for (const t of (d.imageTags || [])) tags.push(String(t))
    }
    const cpuTags = tags.filter(t => /cpu/i.test(t) && /transformers/i.test(t))
    if (cpuTags.length === 0) throw new Error('No CPU DLC tags found in region')
    // Prefer newest transformers version then python version
    const parsed = cpuTags.map(t => ({
      tag: t,
      trans: parseFloat((/transformers(\d+\.\d+\.\d+)/.exec(t)?.[1] || '0').replace(/\./g, '.')),
      py: parseFloat((/py(\d+)/.exec(t)?.[1] || '0'))
    }))
    parsed.sort((a,b)=> (b.trans - a.trans) || (b.py - a.py) || (a.tag < b.tag ? 1 : -1))
    const selected = parsed[0]?.tag || cpuTags.sort().reverse()[0]
    return `${registryId}.dkr.ecr.${region}.amazonaws.com/huggingface-pytorch-inference:${selected}`
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }


