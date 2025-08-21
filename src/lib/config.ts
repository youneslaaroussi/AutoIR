import os from 'node:os'
import path from 'node:path'
import {promises as fs} from 'node:fs'

export type TiDBProfile = {
  host: string
  port?: number
  user: string
  password?: string
  database: string
  caPath?: string
}

export type AppConfig = {
  tidb?: {
    profiles: Record<string, TiDBProfile>
    current?: string
  }
  embed?: {
    provider?: 'sagemaker' | 'bedrock' | 'none'
    // SageMaker embedding endpoint configuration
    sagemakerEndpoint?: string
    sagemakerRegion?: string
    // Bedrock configuration (if used)
    bedrockRegion?: string
    bedrockModel?: string
  }
  llm?: {
    provider?: 'aws' | 'openai'
    // For AWS/Kimi K2 backend, we reuse saved endpoints file; keep current selected name here
    currentEndpoint?: string
    // For OpenAI backend
    openaiApiKey?: string
    openaiModel?: string
  }
  fargate?: {
    cluster?: string
    service?: string
  }
}

const CONFIG_DIR = path.join(os.homedir(), '.autoir')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function writeConfig(cfg: AppConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, {recursive: true})
  const data = JSON.stringify(cfg, null, 2)
  await fs.writeFile(CONFIG_FILE, data, 'utf8')
}

export async function getTiDBProfile(name = 'default'): Promise<TiDBProfile | undefined> {
  const cfg = await readConfig()
  const profiles = cfg.tidb?.profiles || {}
  const key = name || cfg.tidb?.current || 'default'
  return profiles[key]
}

export async function setTiDBProfile(name: string, profile: TiDBProfile, makeCurrent = true): Promise<void> {
  const cfg = await readConfig()
  if (!cfg.tidb) cfg.tidb = {profiles: {}, current: undefined}
  cfg.tidb.profiles[name] = profile
  if (makeCurrent) cfg.tidb.current = name
  await writeConfig(cfg)
}

export function parseMySqlDsn(dsn: string): TiDBProfile | undefined {
  try {
    const u = new URL(dsn)
    if (u.protocol !== 'mysql:' && u.protocol !== 'mysqls:') return undefined
    const profile: TiDBProfile = {
      host: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      user: decodeURIComponent(u.username),
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: u.pathname.replace(/^\//, ''),
    }
    return profile
  } catch {
    return undefined
  }
}

export async function getEmbedConfig(): Promise<Required<NonNullable<AppConfig['embed']>> | undefined> {
  const cfg = await readConfig()
  if (!cfg.embed || !cfg.embed.provider) return undefined
  return cfg.embed as any
}

export async function setEmbedConfig(embed: NonNullable<AppConfig['embed']>): Promise<void> {
  const cfg = await readConfig()
  cfg.embed = embed
  await writeConfig(cfg)
}


export type LlmConfig = Required<NonNullable<AppConfig['llm']>>

export async function getLlmConfig(): Promise<NonNullable<AppConfig['llm']> | undefined> {
  const cfg = await readConfig()
  if (!cfg.llm || !cfg.llm.provider) return undefined
  return cfg.llm
}

export async function setLlmConfig(llm: NonNullable<AppConfig['llm']>): Promise<void> {
  const cfg = await readConfig()
  cfg.llm = llm
  await writeConfig(cfg)
}

export async function getFargateConfig(): Promise<NonNullable<AppConfig['fargate']> | undefined> {
  const cfg = await readConfig()
  if (!cfg.fargate) return undefined
  return cfg.fargate
}

export async function setFargateConfig(fargate: NonNullable<AppConfig['fargate']>): Promise<void> {
  const cfg = await readConfig()
  cfg.fargate = fargate
  await writeConfig(cfg)
}


