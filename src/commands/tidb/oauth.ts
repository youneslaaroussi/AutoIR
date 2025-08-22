import {Command, Flags} from '@oclif/core'
import {execFile, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {platform} from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import ora from 'ora'
import enquirer from 'enquirer'

const execFileAsync = promisify(execFile)

export default class TiDBOauth extends Command {
  static description = 'Authenticate with TiDB Cloud via CLI (ticloud).'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
  ]

  static flags = {
    'dry-run': Flags.boolean({description: 'Show what would be executed', default: false}),
    json: Flags.boolean({description: 'Output machine-readable JSON status', default: false}),
    wait: Flags.boolean({
      description: 'After initiating login, wait until authentication completes (requires ticloud)',
      default: true,
    }),
    timeout: Flags.integer({
      description: 'Maximum seconds to wait for authentication to complete',
      default: 300,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TiDBOauth)

    const resolveTiCloudPath = async (): Promise<string | undefined> => {
      const check = async (bin: string): Promise<boolean> => {
        try {
          await execFileAsync(bin, ['help'])
          return true
        } catch {
          return false
        }
      }

      if (await check('ticloud')) return 'ticloud'
      const home = process.env.HOME || process.env.USERPROFILE
      if (home) {
        const candidate = path.join(home, '.ticloud', 'bin', 'ticloud')
        if (await check(candidate)) return candidate
      }
      return undefined
    }

    const execPath = await resolveTiCloudPath()
    if (!flags.json && execPath) this.log(`[debug] using ticloud at: ${execPath}`)

    if (flags['dry-run']) {
      if (execPath) {
        this.log(`[dry-run] ${execPath} auth login`)
        this.log(`[dry-run] ${execPath} auth login --insecure-storage (fallback)`) 
        if (flags.wait) this.log(`[dry-run] ${execPath} auth whoami (poll)`) 
      } else {
        this.log('[dry-run] require ticloud to complete OAuth programmatically')
        this.log('[dry-run] open https://tidbcloud.com/console/login')
      }
      return
    }

    if (execPath) {
      const runSpawn = async (args: string[]): Promise<number> => {
        if (!flags.json) this.log(`[debug] running: ${execPath} ${args.join(' ')}`)
        return await new Promise<number>((resolve, reject) => {
          const child = spawn(execPath, args, {stdio: 'inherit'})
          child.on('error', reject)
          child.on('close', (code) => resolve(code ?? 1))
        })
      }

      const loginSpinner = flags.json ? undefined : ora('Starting TiDB Cloud login via ticloud...').start()
      const code = await runSpawn(['auth', 'login'])
      if (code === 0) {
        if (loginSpinner) loginSpinner.succeed('Login initiated')
      } else {
        if (loginSpinner) loginSpinner.warn('Login failed')

        // Decide whether to try insecure-storage
        let proceedInsecure = false
        if (flags.json) {
          proceedInsecure = true
        } else {
          const {prompt} = enquirer as unknown as {prompt: <T>(q: any) => Promise<T>}
          const {insecure} = await prompt<{insecure: boolean}>({
            type: 'confirm',
            name: 'insecure',
            message: 'Try again using --insecure-storage (store token in config file)?',
            initial: true,
          })
          proceedInsecure = Boolean(insecure)
        }

        if (!proceedInsecure) {
          this.error('Aborted by user after login failure.')
          return
        }

        const insecureSpinner = flags.json ? undefined : ora('Retrying login with --insecure-storage...').start()
        const code2 = await runSpawn(['auth', 'login', '--insecure-storage'])
        if (code2 === 0) {
          if (insecureSpinner) insecureSpinner.succeed('Login initiated (insecure-storage)')
        } else {
          if (insecureSpinner) insecureSpinner.fail('Login failed (insecure-storage)')
          this.error('ticloud auth login failed (insecure-storage).')
          return
        }
      }

      if (!flags.wait) {
        if (flags.json) this.log(JSON.stringify({method: 'ticloud', status: 'initiated'}))
        return
      }

      const deadline = Date.now() + (flags.timeout ?? 300) * 1000
      const waitSpinner = flags.json ? undefined : ora('Waiting for TiDB Cloud authentication to complete...').start()
      let whoamiText: string | undefined
      while (Date.now() < deadline) {
        try {
          const {stdout} = await execFileAsync(execPath, ['auth', 'whoami'])
          whoamiText = (stdout || '').trim()
          if (!flags.json) this.log('[debug] whoami succeeded')
          break
        } catch (err: any) {
          const estderr = err?.stderr?.toString?.() || ''
          const estdout = err?.stdout?.toString?.() || ''
          if (!flags.json) {
            if (estderr) this.log(`[debug] whoami stderr: ${estderr.substring(0, 400)}`)
            if (estdout) this.log(`[debug] whoami stdout: ${estdout.substring(0, 400)}`)
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
      }

      if (!whoamiText) {
        if (waitSpinner) waitSpinner.fail('Timed out waiting for authentication')
        this.error('Timed out waiting for TiDB Cloud authentication to complete.')
        return
      }

      if (waitSpinner) waitSpinner.succeed('Authenticated')
      if (flags.json) {
        // Parse minimal fields from known format
        const email = /Email:\s*(.+)/i.exec(whoamiText)?.[1]?.trim()
        const userName = /User Name:\s*(.+)/i.exec(whoamiText)?.[1]?.trim()
        const orgName = /Org Name:\s*(.+)/i.exec(whoamiText)?.[1]?.trim()
        this.log(JSON.stringify({method: 'ticloud', status: 'authenticated', whoami: {email, userName, orgName, raw: whoamiText}}))
      } else {
        this.log('Authenticated with TiDB Cloud.')
        // Echo back the lines we received for clarity
        for (const line of whoamiText.split('\n')) this.log(line)
      }
      return
    }

    // Not found: show install hints
    const os = platform()
    this.log(chalk.red('ticloud CLI not found.'))
    if (os === 'darwin') {
      this.log(`Install via Homebrew: ${chalk.cyan('brew install tidbcloud/tidbcloud/ticloud')}`)
      this.log(`Or via script: ${chalk.cyan('curl -fsSL https://raw.githubusercontent.com/tidbcloud/tidbcloud-cli/main/install.sh | bash')}`)
    } else if (os === 'linux') {
      this.log(`Install via script: ${chalk.cyan('curl -fsSL https://raw.githubusercontent.com/tidbcloud/tidbcloud-cli/main/install.sh | bash')}`)
    } else if (os === 'win32') {
      this.log('On Windows, download the latest release from:')
      this.log(chalk.cyan('https://github.com/tidbcloud/tidbcloud-cli/releases'))
      this.log('Alternatively, use WSL and run:')
      this.log(chalk.cyan('curl -fsSL https://raw.githubusercontent.com/tidbcloud/tidbcloud-cli/main/install.sh | bash'))
    }
    this.log(`Docs: ${chalk.cyan('https://docs.pingcap.com/tidbcloud/cli')}`)
    this.exit(1)
  }
}


