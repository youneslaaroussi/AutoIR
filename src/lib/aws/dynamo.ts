import {DynamoDBClient} from "@aws-sdk/client-dynamodb"
import {DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb"

export type DynamoTables = {
  prefix?: string
}

export class DynamoStore {
  private ddb: DynamoDBDocumentClient
  private prefix: string

  constructor(region: string, tables?: DynamoTables) {
    const client = new DynamoDBClient({region})
    this.ddb = DynamoDBDocumentClient.from(client)
    this.prefix = tables?.prefix || "autoir"
  }

  private table(name: string): string {
    return `${this.prefix}_${name}`
  }

  async ensureTables(): Promise<void> {
    // Rely on IaC or external provisioning; keep method for symmetry
    return
  }

  async getCursor(pipelineId: string): Promise<number> {
    const res = await this.ddb.send(new GetCommand({
      TableName: this.table("cursors"),
      Key: { pipeline_id: pipelineId },
      ProjectionExpression: "last_ts_ms"
    }))
    const v = (res.Item as any)?.last_ts_ms
    return typeof v === "number" ? v : 0
  }

  async setCursor(pipelineId: string, lastTsMs: number, lastId?: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.table("cursors"),
      Key: { pipeline_id: pipelineId },
      UpdateExpression: "SET last_ts_ms = :t, last_id = :i",
      ExpressionAttributeValues: { ":t": lastTsMs, ":i": lastId || null }
    }))
  }

  async upsertIncidentByDedupe(record: {
    dedupe_key: string
    severity: 'info'|'low'|'medium'|'high'|'critical'
    title: string
    summary?: string | null
    affected_group?: string | null
    affected_stream?: string | null
    first_ts_ms?: number | null
    last_ts_ms?: number | null
    event_count?: number | null
    sample_ids?: any
    vector_context?: any
    status?: 'open'|'ack'|'resolved'
  }): Promise<{id: string; created: boolean}> {
    const now = Date.now()
    const id = record.dedupe_key
    await this.ddb.send(new PutCommand({
      TableName: this.table("incidents"),
      Item: {
        id,
        created_ms: now,
        updated_ms: now,
        status: record.status || 'open',
        severity: record.severity,
        title: record.title,
        summary: record.summary ?? null,
        affected_group: record.affected_group ?? null,
        affected_stream: record.affected_stream ?? null,
        first_ts_ms: record.first_ts_ms ?? null,
        last_ts_ms: record.last_ts_ms ?? null,
        event_count: record.event_count ?? 0,
        sample_ids: record.sample_ids ?? [],
        vector_context: record.vector_context ?? {},
        dedupe_key: record.dedupe_key
      },
      ConditionExpression: "attribute_not_exists(id)"
    })).catch(async (e: any) => {
      if (e?.name === 'ConditionalCheckFailedException') {
        await this.ddb.send(new UpdateCommand({
          TableName: this.table("incidents"),
          Key: { id },
          UpdateExpression: "SET updated_ms = :u, last_ts_ms = if_not_exists(last_ts_ms, :lt), event_count = if_not_exists(event_count, :z) + :ec, summary = if_not_exists(summary, :s), affected_group = if_not_exists(affected_group, :ag), affected_stream = if_not_exists(affected_stream, :as), vector_context = if_not_exists(vector_context, :vc)",
          ExpressionAttributeValues: {
            ":u": now,
            ":lt": record.last_ts_ms ?? now,
            ":z": 0,
            ":ec": record.event_count ?? 0,
            ":s": record.summary ?? null,
            ":ag": record.affected_group ?? null,
            ":as": record.affected_stream ?? null,
            ":vc": record.vector_context ?? {},
          }
        }))
      } else {
        throw e
      }
    })
    return {id, created: true}
  }
}
