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
    provider?: 'bedrock' | 'none'
    bedrockRegion?: string
    bedrockModel?: string
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


