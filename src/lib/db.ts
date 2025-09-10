import mysql from './mysql-shim.js'
import type {RowDataPacket} from './mysql-shim.js'

export async function ensureAutoIrTables(
  pool: any,
  logsTable = 'autoir_log_events',
): Promise<void> {
  const createLogs = `
    CREATE TABLE IF NOT EXISTS \`${logsTable}\` (
      id VARCHAR(64) PRIMARY KEY,
      log_group VARCHAR(255),
      log_stream VARCHAR(255),
      ts_ms BIGINT,
      message TEXT,
      embedding VECTOR(384) NOT NULL COMMENT 'hnsw(distance=cosine)',
      KEY idx_group_ts (log_group, ts_ms)
    )`;
  await pool.query(createLogs)

  const [rows] = await pool.query(
    `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'embedding'`,
    [logsTable],
  )
  const dt = (rows[0]?.DATA_TYPE || rows[0]?.data_type || '').toString().toLowerCase()
  if (dt !== 'vector') {
    throw new Error(`Table ${logsTable} exists but column 'embedding' is not VECTOR. Please migrate schema to use VECTOR(384).`)
  }

  const createCursors = `
    CREATE TABLE IF NOT EXISTS autoir_cursors (
      pipeline_id VARCHAR(64) PRIMARY KEY,
      last_ts_ms BIGINT NOT NULL DEFAULT 0,
      last_id VARCHAR(64)
    )`;
  await pool.query(createCursors)

  const createIncidents = `
    CREATE TABLE IF NOT EXISTS autoir_incidents (
      id VARCHAR(64) PRIMARY KEY,
      created_ms BIGINT NOT NULL,
      updated_ms BIGINT NOT NULL,
      status ENUM('open','ack','resolved') NOT NULL DEFAULT 'open',
      severity ENUM('info','low','medium','high','critical') NOT NULL,
      title VARCHAR(255) NOT NULL,
      summary TEXT,
      affected_group VARCHAR(255),
      affected_stream VARCHAR(255),
      first_ts_ms BIGINT,
      last_ts_ms BIGINT,
      event_count INT,
      sample_ids JSON,
      vector_context JSON,
      dedupe_key VARCHAR(128),
      UNIQUE KEY uniq_dedupe (dedupe_key),
      KEY idx_status_created (status, created_ms DESC)
    )`;
  await pool.query(createIncidents)
}

export async function getCursor(pool: any, pipelineId: string): Promise<number> {
  const [rows] = await pool.query(
    'SELECT last_ts_ms FROM autoir_cursors WHERE pipeline_id = ? LIMIT 1',
    [pipelineId],
  )
  const last = rows[0]?.last_ts_ms
  return typeof last === 'number' ? last : 0
}

export async function setCursor(pool: any, pipelineId: string, lastTsMs: number, lastId?: string): Promise<void> {
  await pool.query(
    'INSERT INTO autoir_cursors (pipeline_id, last_ts_ms, last_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE last_ts_ms = VALUES(last_ts_ms), last_id = VALUES(last_id)',
    [pipelineId, lastTsMs, lastId || null],
  )
}

export type IncidentRecord = {
  id: string
  created_ms: number
  updated_ms: number
  status: 'open' | 'ack' | 'resolved'
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  title: string
  summary?: string
  affected_group?: string | null
  affected_stream?: string | null
  first_ts_ms?: number | null
  last_ts_ms?: number | null
  event_count?: number | null
  sample_ids?: any
  vector_context?: any
  dedupe_key?: string | null
}

export type NewIncident = Omit<IncidentRecord, 'id' | 'created_ms' | 'updated_ms' | 'status'> & {
  dedupe_key: string
  status?: IncidentRecord['status']
}

export async function upsertIncidentByDedupe(
  pool: any,
  incident: NewIncident,
): Promise<{id: string; created: boolean}> {
  // Try find existing by dedupe_key
  const [existRows] = await pool.query(
    'SELECT id FROM autoir_incidents WHERE dedupe_key = ? LIMIT 1',
    [incident.dedupe_key],
  )
  const now = Date.now()
  if (existRows.length > 0) {
    const id = String(existRows[0].id)
    await pool.query(
      `UPDATE autoir_incidents
       SET updated_ms = ?,
           last_ts_ms = GREATEST(COALESCE(last_ts_ms, 0), ?),
           event_count = COALESCE(event_count, 0) + ?,
           summary = COALESCE(?, summary),
           affected_group = COALESCE(?, affected_group),
           affected_stream = COALESCE(?, affected_stream),
           vector_context = COALESCE(?, vector_context)
       WHERE id = ?`,
      [
        now,
        incident.last_ts_ms ?? now,
        incident.event_count ?? 0,
        incident.summary ?? null,
        incident.affected_group ?? null,
        incident.affected_stream ?? null,
        incident.vector_context ? JSON.stringify(incident.vector_context) : null,
        id,
      ],
    )
    return {id, created: false}
  }

  const id = cryptoRandomId()
  await pool.query(
    `INSERT INTO autoir_incidents
     (id, created_ms, updated_ms, status, severity, title, summary, affected_group, affected_stream,
      first_ts_ms, last_ts_ms, event_count, sample_ids, vector_context, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      now,
      now,
      incident.status || 'open',
      incident.severity,
      incident.title,
      incident.summary ?? null,
      incident.affected_group ?? null,
      incident.affected_stream ?? null,
      incident.first_ts_ms ?? null,
      incident.last_ts_ms ?? null,
      incident.event_count ?? 0,
      incident.sample_ids ? JSON.stringify(incident.sample_ids) : null,
      incident.vector_context ? JSON.stringify(incident.vector_context) : null,
      incident.dedupe_key,
    ],
  )
  return {id, created: true}
}

function cryptoRandomId(): string {
  try {
    const {randomUUID} = require('node:crypto') as typeof import('node:crypto')
    return randomUUID()
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}
