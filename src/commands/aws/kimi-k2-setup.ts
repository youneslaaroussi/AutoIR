import {Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import chalk from 'chalk'
import ora from 'ora'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)

export default class AwsKimiK2Setup extends Command {
  static description = 'Deploy Kimi K2 language model on Amazon EC2 from scratch with quantized inference server'

  static examples = [
    '<%= config.bin %> <%= command.id %> --region us-east-1 --instance-name kimi-k2-dev',
    '<%= config.bin %> <%= command.id %> --region us-east-1 --instance-name kimi-k2-prod --instance-type g6.24xlarge',
  ]

  static flags = {
    region: Flags.string({char: 'r', description: 'AWS region', required: true}),
    profile: Flags.string({char: 'p', description: 'AWS profile to use'}),
    'instance-name': Flags.string({description: 'EC2 instance name', required: true}),
    'instance-type': Flags.string({description: 'EC2 instance type', default: 'g6.16xlarge'}),
    'key-pair': Flags.string({description: 'EC2 Key Pair name (will create if not exists)'}),
    'storage-size': Flags.integer({description: 'Root volume size in GB', default: 500}),
    'allowed-ip': Flags.string({description: 'IP address to allow port 8080 access (defaults to your public IP)'}),
    'quantization': Flags.string({description: 'Quantization level', default: 'UD-TQ1_0', options: ['UD-TQ1_0', 'UD-TQ2_K_XL']}),
    'dry-run': Flags.boolean({description: 'Print commands without executing', default: false}),
    debug: Flags.boolean({description: 'Print AWS CLI stderr on failures', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AwsKimiK2Setup)
    const region = flags.region
    const profile = flags.profile
    const instanceName = flags['instance-name']
    const instanceType = flags['instance-type']
    const storageSize = flags['storage-size']
    const quantization = flags.quantization
    
    const base = ['--region', region]
    if (profile) base.unshift('--profile', profile)

    this.log(chalk.blue('Setting up Kimi K2 on AWS EC2...'))
    this.log(`Instance: ${instanceName} (${instanceType})`)
    this.log(`Region: ${region}`)
    this.log(`Quantization: ${quantization}`)

    // 1) Get our public IP for security group
    let allowedIp = flags['allowed-ip']
    if (!allowedIp) {
      const sp = ora('Getting your public IP address').start()
      try {
        const {stdout} = await execFileAsync('curl', ['-s', 'https://checkip.amazonaws.com'])
        allowedIp = stdout.trim() + '/32'
        sp.succeed(`Found public IP: ${allowedIp}`)
      } catch (e) {
        sp.warn('Could not determine public IP automatically')
        allowedIp = '0.0.0.0/0'
        this.log(chalk.yellow('Using 0.0.0.0/0 (open to world) - consider specifying --allowed-ip'))
      }
    }

    // 2) Create or ensure key pair exists
    const keyPairName = flags['key-pair'] || `${instanceName}-key`
    await this.ensureKeyPair(keyPairName, base, flags['dry-run'], flags.debug)

    // 3) Create security group
    const sgName = `${instanceName}-sg`
    const sgId = await this.createSecurityGroup(sgName, allowedIp, base, flags['dry-run'], flags.debug)

    // 4) Find the latest Deep Learning AMI
    const amiId = await this.findDeepLearningAmi(base, flags['dry-run'], flags.debug)

    // 5) Create user data script for setup
    const userData = this.generateUserData(quantization)

    // 6) Launch EC2 instance
    const instanceId = await this.launchInstance({
      name: instanceName,
      type: instanceType,
      amiId,
      keyPair: keyPairName,
      securityGroup: sgId,
      storageSize,
      userData,
      base,
      dryRun: flags['dry-run'],
      debug: flags.debug
    })

    if (flags['dry-run']) {
      this.log(chalk.cyan('[dry-run] ') + 'Complete setup would include:')
      this.log('- EC2 instance launch')
      this.log('- Automatic Kimi K2 installation')
      this.log('- API endpoint configuration')
      return
    }

    // 7) Wait for instance to be running and get public IP
    const instanceInfo = await this.waitForInstance(instanceId, base, flags.debug)

    // 8) Save endpoint configuration
    await this.saveEndpointConfig(instanceName, instanceInfo, region, quantization)

    // 9) Wait for setup to complete and test endpoint
    await this.waitForSetupAndTest(instanceInfo.publicIp, flags.debug)

    this.log(chalk.green('Kimi K2 setup complete!'))
    this.log(`Endpoint: http://${instanceInfo.publicIp}:8080`)
    this.log(`Instance ID: ${instanceId}`)
    this.log('')
    this.log('Test the endpoint:')
    this.log(chalk.cyan(`curl -X POST http://${instanceInfo.publicIp}:8080/completion \\`))
    this.log(chalk.cyan(`  -H "Content-Type: application/json" \\`))
    this.log(chalk.cyan(`  -d '{"prompt": "<|im_system|>system<|im_middle|>You are a helpful assistant<|im_end|><|im_user|>user<|im_middle|>Hello!<|im_end|><|im_assistant|>assistant<|im_middle|>", "temperature": 0.6, "min_p": 0.01, "n_predict": 100}'`))
  }

  private async ensureKeyPair(keyPairName: string, base: string[], dryRun: boolean, debug: boolean) {
    const sp = ora(`Ensuring key pair: ${keyPairName}`).start()
    
    if (dryRun) {
      sp.succeed('[dry-run] Key pair check')
      return
    }

    try {
      // Check if key pair exists
      await execFileAsync('aws', ['ec2', 'describe-key-pairs', '--key-names', keyPairName, ...base])
      sp.succeed('Key pair already exists')
    } catch (e) {
      // Create new key pair
      try {
        const {stdout} = await execFileAsync('aws', ['ec2', 'create-key-pair', '--key-name', keyPairName, '--query', 'KeyMaterial', '--output', 'text', ...base])
        
        // Save private key to file
        const keyPath = path.join(os.homedir(), '.ssh', `${keyPairName}.pem`)
        await fs.mkdir(path.dirname(keyPath), {recursive: true})
        await fs.writeFile(keyPath, stdout, {mode: 0o600})
        
        sp.succeed(`Created key pair and saved to ${keyPath}`)
      } catch (createError: any) {
        sp.fail('Failed to create key pair')
        if (debug) this.log(chalk.gray(createError?.message || String(createError)))
        throw createError
      }
    }
  }

  private async createSecurityGroup(sgName: string, allowedIp: string, base: string[], dryRun: boolean, debug: boolean): Promise<string> {
    const sp = ora(`Creating security group: ${sgName}`).start()
    
    if (dryRun) {
      sp.succeed('[dry-run] Security group creation')
      return 'sg-dry-run'
    }

    try {
      // Check if security group exists
      const {stdout: describeOut} = await execFileAsync('aws', ['ec2', 'describe-security-groups', '--group-names', sgName, '--query', 'SecurityGroups[0].GroupId', '--output', 'text', ...base])
      const existingSgId = describeOut.trim()
      if (existingSgId && existingSgId !== 'None') {
        sp.succeed('Security group already exists')
        return existingSgId
      }
    } catch (e) {
      // Group doesn't exist, create it
    }

    try {
      // Create security group
      const {stdout} = await execFileAsync('aws', ['ec2', 'create-security-group', '--group-name', sgName, '--description', 'Kimi K2 API access', '--query', 'GroupId', '--output', 'text', ...base])
      const sgId = stdout.trim()

      // Add rule for SSH (port 22)
      await execFileAsync('aws', ['ec2', 'authorize-security-group-ingress', '--group-id', sgId, '--protocol', 'tcp', '--port', '22', '--cidr', allowedIp, ...base])
      
      // Add rule for Kimi K2 API (port 8080)
      await execFileAsync('aws', ['ec2', 'authorize-security-group-ingress', '--group-id', sgId, '--protocol', 'tcp', '--port', '8080', '--cidr', allowedIp, ...base])

      sp.succeed(`Created security group: ${sgId}`)
      return sgId
    } catch (createError: any) {
      sp.fail('Failed to create security group')
      if (debug) this.log(chalk.gray(createError?.message || String(createError)))
      throw createError
    }
  }

  private async findDeepLearningAmi(base: string[], dryRun: boolean, debug: boolean): Promise<string> {
    const sp = ora('Finding latest Deep Learning AMI').start()
    
    if (dryRun) {
      sp.succeed('[dry-run] AMI lookup')
      return 'ami-dry-run'
    }

    try {
      const {stdout} = await execFileAsync('aws', [
        'ec2', 'describe-images',
        '--owners', 'amazon',
        '--filters', 
        'Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023)*',
        'Name=state,Values=available',
        '--query', 'Images | sort_by(@, &CreationDate) | [-1].ImageId',
        '--output', 'text',
        ...base
      ])
      
      const amiId = stdout.trim()
      sp.succeed(`Found AMI: ${amiId}`)
      return amiId
    } catch (error: any) {
      sp.fail('Failed to find Deep Learning AMI')
      if (debug) this.log(chalk.gray(error?.message || String(error)))
      throw error
    }
  }

  private generateUserData(quantization: string): string {
    return `#!/bin/bash
set -e

# Log all output
exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting Kimi K2 setup at $(date)"

# Update system packages
dnf update -y
dnf install pciutils cmake curl libcurl-devel gcc-c++ make python3-pip python3-devel git -y

# Create model cache directory and set up environment variables
mkdir -p /root/model_cache
cat >> /root/.bashrc << 'EOF'
export LLAMA_CACHE="/root/model_cache"
export PATH=/usr/local/cuda-12.8/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.8/lib64:$LD_LIBRARY_PATH
export CUDA_HOME=/usr/local/cuda-12.8
export CUDA_VISIBLE_DEVICES=0
EOF

# Source environment
source /root/.bashrc

# Clone and build llama.cpp (Unsloth fork)
cd /root
git clone https://github.com/unslothai/llama.cpp

cmake llama.cpp -B llama.cpp/build \\
-DBUILD_SHARED_LIBS=OFF \\
-DGGML_CUDA=ON \\
-DLLAMA_CURL=ON \\
-DCMAKE_CUDA_COMPILER=/usr/local/cuda-12.8/bin/nvcc

# Build llama-server
cmake --build llama.cpp/build --config Release -j --clean-first --target llama-server

# Create bin directory and copy binaries
mkdir -p /root/bin 
cp llama.cpp/build/bin/llama-server /root/bin/

# Create server script
cat > /root/start_kimi_server.sh << 'SERVEREOF'
#!/bin/bash
export LLAMA_CACHE="/root/model_cache"
export PATH=/usr/local/cuda-12.8/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.8/lib64:$LD_LIBRARY_PATH
export CUDA_HOME=/usr/local/cuda-12.8
export CUDA_VISIBLE_DEVICES=0
/root/bin/llama-server \\
-hf unsloth/Kimi-K2-Instruct-GGUF:${quantization} \\
--cache-type-k q4_0 \\
--threads -1 \\
--n-gpu-layers 99 \\
--temp 0.6 \\
--min_p 0.01 \\
--ctx-size 16384 \\
--seed 3407 \\
-ot ".ffn\\\\.\\\\*_exps.=CPU" \\
--jinja \\
--host 0.0.0.0 \\
--port 8080 \\
--no-webui
SERVEREOF
chmod +x /root/start_kimi_server.sh

# Create systemd service
cat > /etc/systemd/system/kimi-server.service << 'SERVICEEOF'
[Unit]
Description=Kimi K2 LLM Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/root/start_kimi_server.sh
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
SERVICEEOF

# Enable and start the service
systemctl daemon-reload
systemctl enable kimi-server
systemctl start kimi-server

# Create a simple health check endpoint
cat > /root/health_check.sh << 'HEALTHEOF'
#!/bin/bash
curl -s -f http://localhost:8080/health || echo "Service not ready yet"
HEALTHEOF
chmod +x /root/health_check.sh

echo "Kimi K2 setup completed at $(date)"
echo "Service status:"
systemctl status kimi-server --no-pager
`
  }

  private async launchInstance(params: {
    name: string,
    type: string,
    amiId: string,
    keyPair: string,
    securityGroup: string,
    storageSize: number,
    userData: string,
    base: string[],
    dryRun: boolean,
    debug: boolean
  }): Promise<string> {
    const sp = ora(`Launching EC2 instance: ${params.name}`).start()
    
    if (params.dryRun) {
      sp.succeed('[dry-run] Instance launch')
      return 'i-dry-run'
    }

    try {
      // Encode user data as base64
      const userDataB64 = Buffer.from(params.userData).toString('base64')

      const {stdout} = await execFileAsync('aws', [
        'ec2', 'run-instances',
        '--image-id', params.amiId,
        '--count', '1',
        '--instance-type', params.type,
        '--key-name', params.keyPair,
        '--security-group-ids', params.securityGroup,
        '--user-data', userDataB64,
        '--block-device-mappings', JSON.stringify([{
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: params.storageSize,
            VolumeType: 'gp3',
            DeleteOnTermination: true
          }
        }]),
        '--tag-specifications', JSON.stringify([{
          ResourceType: 'instance',
          Tags: [
            {Key: 'Name', Value: params.name},
            {Key: 'Purpose', Value: 'Kimi-K2-LLM'}
          ]
        }]),
        '--query', 'Instances[0].InstanceId',
        '--output', 'text',
        ...params.base
      ])

      const instanceId = stdout.trim()
      sp.succeed(`Launched instance: ${instanceId}`)
      return instanceId
    } catch (error: any) {
      sp.fail('Failed to launch instance')
      if (params.debug) this.log(chalk.gray(error?.message || String(error)))
      throw error
    }
  }

  private async waitForInstance(instanceId: string, base: string[], debug: boolean): Promise<{publicIp: string, privateIp: string}> {
    const sp = ora('Waiting for instance to be running...').start()
    
    const deadline = Date.now() + 10 * 60_000 // 10 minutes
    while (Date.now() < deadline) {
      try {
        const {stdout} = await execFileAsync('aws', [
          'ec2', 'describe-instances',
          '--instance-ids', instanceId,
          '--query', 'Reservations[0].Instances[0].[State.Name,PublicIpAddress,PrivateIpAddress]',
          '--output', 'text',
          ...base
        ])
        
        const [state, publicIp, privateIp] = stdout.trim().split('\t')
        sp.text = `Instance state: ${state}`
        
        if (state === 'running' && publicIp && publicIp !== 'None') {
          sp.succeed(`Instance running at ${publicIp}`)
          return {publicIp, privateIp}
        }
        
        if (state === 'terminated' || state === 'stopped') {
          throw new Error(`Instance ${state}`)
        }
      } catch (e: any) {
        if (debug) this.log(chalk.gray(e?.message || String(e)))
      }
      
      await new Promise(r => setTimeout(r, 10000))
    }
    
    sp.fail('Timeout waiting for instance')
    throw new Error('Instance did not start within timeout')
  }

  private async saveEndpointConfig(name: string, instanceInfo: {publicIp: string, privateIp: string}, region: string, quantization: string) {
    const sp = ora('Saving endpoint configuration').start()
    
    try {
      const configDir = path.join(os.homedir(), '.autoir')
      await fs.mkdir(configDir, {recursive: true})
      
      const configPath = path.join(configDir, 'kimi-k2-endpoints.json')
      let config: any = {}
      
      try {
        const existingConfig = await fs.readFile(configPath, 'utf-8')
        config = JSON.parse(existingConfig)
      } catch (e) {
        // File doesn't exist, start with empty config
      }
      
      config[name] = {
        endpoint: `http://${instanceInfo.publicIp}:8080`,
        publicIp: instanceInfo.publicIp,
        privateIp: instanceInfo.privateIp,
        region,
        quantization,
        createdAt: new Date().toISOString()
      }
      
      await fs.writeFile(configPath, JSON.stringify(config, null, 2))
      sp.succeed(`Saved endpoint config to ${configPath}`)
    } catch (error: any) {
      sp.warn('Failed to save endpoint config')
      this.log(chalk.gray(error?.message || String(error)))
    }
  }

  private async waitForSetupAndTest(publicIp: string, debug: boolean) {
    const sp = ora('Waiting for Kimi K2 setup to complete (this may take 10-30 minutes)...').start()
    
    const deadline = Date.now() + 45 * 60_000 // 45 minutes for initial model download
    let setupComplete = false
    
    while (Date.now() < deadline && !setupComplete) {
      try {
        // Try to hit the health endpoint or any endpoint to see if server is responding
        const {stdout} = await execFileAsync('curl', [
          '-s', '-f', '--connect-timeout', '10', '--max-time', '30',
          `http://${publicIp}:8080/health`
        ])
        
        if (stdout.includes('model') || stdout.includes('ok') || stdout.includes('ready')) {
          setupComplete = true
          sp.succeed('Kimi K2 setup and model download complete!')
          break
        }
      } catch (e) {
        // Still setting up, that's expected
      }
      
      // Also try a simple completion request to test if the model is loaded
      try {
        const testPayload = JSON.stringify({
          prompt: '<|im_system|>system<|im_middle|>Test<|im_end|><|im_user|>user<|im_middle|>Hi<|im_end|><|im_assistant|>assistant<|im_middle|>',
          temperature: 0.6,
          min_p: 0.01,
          n_predict: 10
        })
        
        const {stdout} = await execFileAsync('curl', [
          '-s', '-f', '--connect-timeout', '10', '--max-time', '60',
          '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-d', testPayload,
          `http://${publicIp}:8080/completion`
        ])
        
        if (stdout.includes('content') || stdout.includes('response')) {
          setupComplete = true
          sp.succeed('Kimi K2 is ready and responding to requests!')
          
          // Show a sample of the response
          try {
            const response = JSON.parse(stdout)
            if (response.content) {
              this.log(chalk.green('Test response: ') + response.content.slice(0, 100) + '...')
            }
          } catch (e) {
            // Response might not be JSON, that's ok
          }
          break
        }
      } catch (e) {
        // Still setting up
        if (debug) {
          const msg = (e as any)?.message || String(e)
          if (!msg.includes('Connection refused') && !msg.includes('timeout')) {
            this.log(chalk.gray(`Test attempt: ${msg}`))
          }
        }
      }
      
      await new Promise(r => setTimeout(r, 30000)) // Check every 30 seconds
    }
    
    if (!setupComplete) {
      sp.warn('Setup may still be in progress. Check instance logs for details.')
      this.log(chalk.yellow('The model download and setup can take up to 45 minutes.'))
      this.log(chalk.yellow(`You can check progress by SSH'ing to the instance and running:`))
      this.log(chalk.cyan('sudo journalctl -u kimi-server -f'))
    }
  }
}
