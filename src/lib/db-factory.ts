import mysql from 'mysql2/promise'
import {MockTiDB} from './mock-tidb.js'
import {getTiDBProfile} from './config.js'

let mockDb: MockTiDB | null = null

export class DatabaseConnection {
  private pool?: mysql.Pool
  private mockDb?: MockTiDB
  private isUsingMock: boolean = false

  async initialize(forceReal = false): Promise<void> {
    // Check if we should force demo mode
    const demoMode = process.env.DEMO_MODE === 'true' || !forceReal
    
    if (demoMode) {
      this.isUsingMock = true
      if (!mockDb) {
        mockDb = new MockTiDB()
        await mockDb.initialize()
      }
      this.mockDb = mockDb
      return
    }

    // Try to get real TiDB connection
    try {
      const profile = await getTiDBProfile()
      if (!profile) {
        throw new Error('No TiDB profile configured')
      }

      this.pool = mysql.createPool({
        host: profile.host,
        port: profile.port || 4000,
        user: profile.user,
        password: profile.password,
        database: profile.database,
        ssl: profile.caPath ? {ca: profile.caPath} : undefined,
        connectionLimit: 10,
      })

      // Test connection
      await this.pool.query('SELECT 1')
      this.isUsingMock = false
    } catch (error) {
      console.warn('Failed to connect to real TiDB, falling back to mock:', error)
      this.isUsingMock = true
      if (!mockDb) {
        mockDb = new MockTiDB()
        await mockDb.initialize()
      }
      this.mockDb = mockDb
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    if (this.isUsingMock && this.mockDb) {
      return this.mockDb.query(sql, params) as Promise<T[]>
    }

    if (!this.pool) {
      throw new Error('Database not initialized')
    }

    const [rows] = await this.pool.query(sql, params)
    return rows as T[]
  }

  async insertLogEvent(event: {
    log_group: string
    log_stream: string
    ts_ms: number
    message: string
    embedding: number[]
  }): Promise<string> {
    if (this.isUsingMock && this.mockDb) {
      return this.mockDb.insertLogEvent(event)
    }

    const id = this.generateId()
    await this.query(
      'INSERT INTO autoir_log_events (id, log_group, log_stream, ts_ms, message, embedding) VALUES (?,?,?,?,?,CAST(? AS VECTOR(384)))',
      [id, event.log_group, event.log_stream, event.ts_ms, event.message, JSON.stringify(event.embedding)]
    )
    return id
  }

  async insertIncident(incident: {
    created_ms: number
    updated_ms: number
    status?: 'open' | 'ack' | 'resolved'
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
    title: string
    summary?: string
    affected_group?: string
    affected_stream?: string
    first_ts_ms?: number
    last_ts_ms?: number
    event_count?: number
    sample_ids?: any
    vector_context?: any
    dedupe_key?: string
  }): Promise<string> {
    if (this.isUsingMock && this.mockDb) {
      const incidentData = {
        ...incident,
        status: incident.status || 'open' as const
      }
      return this.mockDb.insertIncident(incidentData)
    }

    const id = this.generateId()
    await this.query(
      `INSERT INTO autoir_incidents 
       (id, created_ms, updated_ms, status, severity, title, summary, affected_group, affected_stream,
        first_ts_ms, last_ts_ms, event_count, sample_ids, vector_context, dedupe_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        incident.created_ms,
        incident.updated_ms,
        incident.status || 'open',
        incident.severity,
        incident.title,
        incident.summary || null,
        incident.affected_group || null,
        incident.affected_stream || null,
        incident.first_ts_ms || null,
        incident.last_ts_ms || null,
        incident.event_count || 0,
        incident.sample_ids ? JSON.stringify(incident.sample_ids) : null,
        incident.vector_context ? JSON.stringify(incident.vector_context) : null,
        incident.dedupe_key || null,
      ]
    )
    return id
  }

  getStats() {
    if (this.isUsingMock && this.mockDb) {
      return this.mockDb.getStats()
    }

    // For real DB, would query actual stats
    return {
      totalEvents: 0,
      recentEvents: 0,
      totalIncidents: 0,
      openIncidents: 0,
      resolvedIncidents: 0,
      avgResolutionTime: 'N/A',
      systemHealth: 'N/A'
    }
  }

  isUsingMockDatabase(): boolean {
    return this.isUsingMock
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
    }
  }
}

// Global database instance
let globalDb: DatabaseConnection | null = null

export async function getDatabase(): Promise<DatabaseConnection> {
  if (!globalDb) {
    globalDb = new DatabaseConnection()
    await globalDb.initialize()
  }
  return globalDb
}

export async function closeDatabaseConnection(): Promise<void> {
  if (globalDb) {
    await globalDb.close()
    globalDb = null
  }
}