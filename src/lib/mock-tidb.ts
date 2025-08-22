import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'

interface LogEvent {
  id: string
  log_group: string
  log_stream: string
  ts_ms: number
  message: string
  embedding: number[]
}

interface Incident {
  id: string
  created_ms: number
  updated_ms: number
  status: 'open' | 'ack' | 'resolved'
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
}

interface Cursor {
  pipeline_id: string
  last_ts_ms: number
  last_id?: string
}

const MOCK_DB_DIR = path.join(os.homedir(), '.autoir', 'mock-db')
const LOG_EVENTS_FILE = path.join(MOCK_DB_DIR, 'log_events.json')
const INCIDENTS_FILE = path.join(MOCK_DB_DIR, 'incidents.json')
const CURSORS_FILE = path.join(MOCK_DB_DIR, 'cursors.json')

export class MockTiDB {
  private logEvents: LogEvent[] = []
  private incidents: Incident[] = []
  private cursors: Cursor[] = []

  async initialize(): Promise<void> {
    await fs.mkdir(MOCK_DB_DIR, {recursive: true})
    
    // Load existing data or create sample data
    await this.loadData()
    
    // Generate realistic demo data if empty
    if (this.logEvents.length === 0) {
      await this.generateDemoData()
    }
  }

  private async loadData(): Promise<void> {
    try {
      const logEventsData = await fs.readFile(LOG_EVENTS_FILE, 'utf8')
      this.logEvents = JSON.parse(logEventsData)
    } catch {
      this.logEvents = []
    }

    try {
      const incidentsData = await fs.readFile(INCIDENTS_FILE, 'utf8')
      this.incidents = JSON.parse(incidentsData)
    } catch {
      this.incidents = []
    }

    try {
      const cursorsData = await fs.readFile(CURSORS_FILE, 'utf8')
      this.cursors = JSON.parse(cursorsData)
    } catch {
      this.cursors = []
    }
  }

  private async saveData(): Promise<void> {
    await fs.writeFile(LOG_EVENTS_FILE, JSON.stringify(this.logEvents, null, 2))
    await fs.writeFile(INCIDENTS_FILE, JSON.stringify(this.incidents, null, 2))
    await fs.writeFile(CURSORS_FILE, JSON.stringify(this.cursors, null, 2))
  }

  private async generateDemoData(): Promise<void> {
    const now = Date.now()
    const oneHourAgo = now - (60 * 60 * 1000)
    
    // Generate realistic log events
    const logGroups = [
      '/aws/lambda/user-api',
      '/aws/lambda/payment-service',
      '/aws/lambda/order-processor',
      '/aws/lambda/auth-service',
      '/aws/ecs/web-frontend',
      '/aws/rds/aurora-cluster',
      '/aws/apigateway/prod'
    ]

    const logStreams = [
      'prod-instance-001',
      'prod-instance-002',
      'prod-instance-003',
      'staging-instance-001'
    ]

    const sampleMessages = [
      'INFO: Request processed successfully in 245ms',
      'WARN: Database connection pool utilization at 85%',
      'ERROR: Connection timeout after 30 seconds',
      'INFO: User authentication successful',
      'ERROR: Payment processing failed - invalid card',
      'INFO: Order created successfully',
      'WARN: High memory usage detected: 92%',
      'ERROR: Database connection pool exhausted',
      'INFO: Cache hit ratio: 94%',
      'ERROR: API rate limit exceeded for client',
      'INFO: Scheduled backup completed',
      'WARN: Disk usage above threshold: 88%',
      'ERROR: Service unavailable - circuit breaker open',
      'INFO: Auto-scaling triggered - adding 2 instances',
      'ERROR: Failed to connect to external service',
      'INFO: Health check passed',
      'WARN: Unusual traffic pattern detected',
      'ERROR: Database deadlock detected and resolved',
      'INFO: SSL certificate renewed successfully',
      'ERROR: Memory allocation failed'
    ]

    for (let i = 0; i < 500; i++) {
      const logGroup = logGroups[Math.floor(Math.random() * logGroups.length)]
      const logStream = logStreams[Math.floor(Math.random() * logStreams.length)]
      const message = sampleMessages[Math.floor(Math.random() * sampleMessages.length)]
      const timestamp = oneHourAgo + Math.random() * (now - oneHourAgo)
      
      // Generate a fake embedding (384 dimensions)
      const embedding = Array.from({length: 384}, () => Math.random() * 2 - 1)
      
      this.logEvents.push({
        id: this.generateId(),
        log_group: logGroup,
        log_stream: logStream,
        ts_ms: Math.floor(timestamp),
        message,
        embedding
      })
    }

    // Generate some incidents
    const incidents = [
      {
        severity: 'critical' as const,
        title: 'Database Connection Pool Exhaustion',
        summary: 'Multiple services experiencing connection timeouts',
        affected_group: '/aws/rds/aurora-cluster',
        affected_stream: 'prod-instance-001'
      },
      {
        severity: 'high' as const,
        title: 'API Rate Limiting Triggered',
        summary: 'Unusual traffic patterns causing rate limit activation',
        affected_group: '/aws/apigateway/prod',
        affected_stream: 'prod-instance-001'
      },
      {
        severity: 'medium' as const,
        title: 'High Memory Usage Alert',
        summary: 'Memory utilization above 90% threshold',
        affected_group: '/aws/lambda/user-api',
        affected_stream: 'prod-instance-002'
      }
    ]

    for (const incident of incidents) {
      this.incidents.push({
        id: this.generateId(),
        created_ms: now - Math.random() * (60 * 60 * 1000),
        updated_ms: now - Math.random() * (30 * 60 * 1000),
        status: Math.random() > 0.3 ? 'resolved' : 'open',
        ...incident,
        first_ts_ms: oneHourAgo,
        last_ts_ms: now,
        event_count: Math.floor(Math.random() * 100) + 10,
        sample_ids: JSON.stringify([this.generateId(), this.generateId()]),
        vector_context: JSON.stringify({query: 'error timeout connection'}),
        dedupe_key: `${incident.title.toLowerCase().replace(/\s+/g, '_')}_${incident.affected_group}`
      })
    }

    await this.saveData()
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  // Mock SQL query execution
  async query(sql: string, params?: any[]): Promise<any[]> {
    const normalizedSql = sql.toLowerCase().trim()
    
    // Handle vector similarity search
    if (normalizedSql.includes('vec_cosine_distance') || normalizedSql.includes('<=>')) {
      return this.handleVectorSearch(sql, params)
    }
    
    // Handle incident queries
    if (normalizedSql.includes('autoir_incidents')) {
      return this.handleIncidentQuery(sql, params)
    }
    
    // Handle log event queries
    if (normalizedSql.includes('autoir_log_events')) {
      return this.handleLogEventQuery(sql, params)
    }
    
    // Handle cursor queries
    if (normalizedSql.includes('autoir_cursors')) {
      return this.handleCursorQuery(sql, params)
    }
    
    // Handle table creation (no-op for mock)
    if (normalizedSql.includes('create table')) {
      return []
    }
    
    // Handle information schema queries
    if (normalizedSql.includes('information_schema')) {
      return [{DATA_TYPE: 'vector', data_type: 'vector'}]
    }
    
    // Default empty result
    return []
  }

  private async handleVectorSearch(sql: string, params?: any[]): Promise<any[]> {
    // Simulate vector search by returning random similar results
    const limit = this.extractLimit(sql) || 20
    const results = []
    
    // Get random log events and add similarity scores
    const shuffled = [...this.logEvents].sort(() => Math.random() - 0.5)
    
    for (let i = 0; i < Math.min(limit, shuffled.length); i++) {
      const event = shuffled[i]
      const score = Math.random() * 0.8 + 0.2 // Random similarity score between 0.2-1.0
      const distance = 1 - score
      
      results.push({
        ...event,
        score,
        distance
      })
    }
    
    // Sort by distance (ascending)
    results.sort((a, b) => a.distance - b.distance)
    
    return results
  }

  private async handleLogEventQuery(sql: string, params?: any[]): Promise<any[]> {
    const limit = this.extractLimit(sql) || 100
    let results = [...this.logEvents]
    
    // Apply basic filtering
    if (sql.includes('WHERE')) {
      // Simple time-based filtering
      if (sql.includes('ts_ms >')) {
        const now = Date.now()
        const oneHourAgo = now - (60 * 60 * 1000)
        results = results.filter(e => e.ts_ms > oneHourAgo)
      }
    }
    
    // Apply ordering
    if (sql.includes('ORDER BY')) {
      if (sql.includes('ts_ms DESC')) {
        results.sort((a, b) => b.ts_ms - a.ts_ms)
      } else if (sql.includes('ts_ms ASC')) {
        results.sort((a, b) => a.ts_ms - b.ts_ms)
      }
    }
    
    return results.slice(0, limit)
  }

  private async handleIncidentQuery(sql: string, params?: any[]): Promise<any[]> {
    const limit = this.extractLimit(sql) || 100
    let results = [...this.incidents]
    
    // Apply basic filtering
    if (sql.includes('WHERE')) {
      if (sql.includes('status =')) {
        const status = params?.[0] || 'open'
        results = results.filter(i => i.status === status)
      }
      
      if (sql.includes('dedupe_key =')) {
        const dedupeKey = params?.[0]
        results = results.filter(i => i.dedupe_key === dedupeKey)
      }
    }
    
    // Apply ordering
    if (sql.includes('ORDER BY')) {
      if (sql.includes('created_ms DESC')) {
        results.sort((a, b) => b.created_ms - a.created_ms)
      }
    }
    
    return results.slice(0, limit)
  }

  private async handleCursorQuery(sql: string, params?: any[]): Promise<any[]> {
    if (sql.includes('INSERT') || sql.includes('UPDATE')) {
      // Handle cursor updates
      const pipelineId = params?.[0]
      if (pipelineId) {
        const existing = this.cursors.findIndex(c => c.pipeline_id === pipelineId)
        const cursor = {
          pipeline_id: pipelineId,
          last_ts_ms: params?.[1] || Date.now(),
          last_id: params?.[2]
        }
        
        if (existing >= 0) {
          this.cursors[existing] = cursor
        } else {
          this.cursors.push(cursor)
        }
        
        await this.saveData()
      }
      return []
    }
    
    // Handle cursor selects
    const pipelineId = params?.[0]
    const cursor = this.cursors.find(c => c.pipeline_id === pipelineId)
    return cursor ? [cursor] : []
  }

  private extractLimit(sql: string): number | null {
    const match = sql.match(/LIMIT\s+(\d+)/i)
    return match ? parseInt(match[1], 10) : null
  }

  // Insert new log event
  async insertLogEvent(event: Omit<LogEvent, 'id'>): Promise<string> {
    const id = this.generateId()
    const newEvent = {id, ...event}
    this.logEvents.push(newEvent)
    await this.saveData()
    return id
  }

  // Insert new incident
  async insertIncident(incident: Omit<Incident, 'id'>): Promise<string> {
    const id = this.generateId()
    const newIncident = {id, ...incident}
    this.incidents.push(newIncident)
    await this.saveData()
    return id
  }

  // Get statistics for demo purposes
  getStats() {
    const now = Date.now()
    const oneHourAgo = now - (60 * 60 * 1000)
    
    const recentEvents = this.logEvents.filter(e => e.ts_ms > oneHourAgo)
    const openIncidents = this.incidents.filter(i => i.status === 'open')
    const resolvedIncidents = this.incidents.filter(i => i.status === 'resolved')
    
    return {
      totalEvents: this.logEvents.length,
      recentEvents: recentEvents.length,
      totalIncidents: this.incidents.length,
      openIncidents: openIncidents.length,
      resolvedIncidents: resolvedIncidents.length,
      avgResolutionTime: '4m 32s',
      systemHealth: '98.7%'
    }
  }
}