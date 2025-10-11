import {SignatureV4} from "@aws-sdk/signature-v4"
import {Sha256} from "@aws-crypto/sha256-js"
import {defaultProvider} from "@aws-sdk/credential-provider-node"
import {HttpRequest} from "@aws-sdk/protocol-http"

export type OpenSearchClientOptions = {
  endpoint: string
  region: string
  service?: "aoss" | "es"
}

export type LogDoc = {
  id: string
  log_group: string
  log_stream: string
  ts_ms: number
  message: string
  embedding?: number[]
}

export class OpenSearchClient {
  private endpointUrl: URL
  private signer: SignatureV4
  private service: "aoss" | "es"

  constructor(private opts: OpenSearchClientOptions) {
    this.endpointUrl = new URL(opts.endpoint)
    this.service = opts.service || (this.endpointUrl.hostname.includes("aoss") ? "aoss" : "es")
    this.signer = new SignatureV4({
      service: this.service,
      region: opts.region,
      credentials: defaultProvider(),
      sha256: Sha256,
    })
  }

  async ensureIndex(indexName: string, dims = 384): Promise<void> {
    const exists = await this.head(`/${encodeURIComponent(indexName)}`)
    if (exists) return
    const body = {
      settings: { index: { knn: true } },
      mappings: {
        properties: {
          id: {type: "keyword"},
          log_group: {type: "keyword"},
          log_stream: {type: "keyword"},
          ts_ms: {type: "date", format: "epoch_millis"},
          message: {type: "text"},
          embedding: {
            type: "knn_vector",
            dimension: dims,
            method: { name: "hnsw", space_type: "cosinesimil", engine: "nmslib" },
          },
        },
      },
    }
    await this.put(`/${encodeURIComponent(indexName)}`, body)
  }

  async bulkIndex(indexName: string, docs: LogDoc[]): Promise<void> {
    if (!docs.length) return
    let body = ""
    for (const d of docs) {
      body += JSON.stringify({ index: { _index: indexName, _id: d.id } }) + "\n"
      const {embedding, ...rest} = d as any
      body += JSON.stringify({ ...rest, embedding: embedding || [] }) + "\n"
    }
    await this.post("/_bulk", body, {"content-type": "application/x-ndjson"})
  }

  async searchByVector(indexName: string, vector: number[], size = 20, opts?: {group?: string; sinceMs?: number; minLen?: number}): Promise<Array<LogDoc & {distance: number}>> {
    const must: any[] = []
    if (opts?.group) must.push({ term: { log_group: opts.group } })
    if (opts?.sinceMs) must.push({ range: { ts_ms: { gte: opts.sinceMs } } })
    // Note: message length filter uses script; ensure painless is enabled
    if (opts?.minLen) must.push({ script: { script: { source: 'doc["message"].value.length() >= params.min', lang: 'painless', params: {min: opts.minLen} } } })
    const body: any = {
      size,
      query: {
        bool: {
          must,
          should: [
            { knn: { embedding: { vector, k: size } } },
          ],
        },
      },
      _source: ["id","log_group","log_stream","ts_ms","message"],
    }
    const res = await this.post(`/${encodeURIComponent(indexName)}/_search`, body)
    const hits = (res as any)?.hits?.hits || []
    return hits.map((h: any) => ({
      id: h._id,
      log_group: h._source?.log_group,
      log_stream: h._source?.log_stream,
      ts_ms: h._source?.ts_ms,
      message: h._source?.message,
      distance: typeof h._score === 'number' ? 1 - h._score : 0,
    }))
  }

  async searchText(indexName: string, text: string, size = 50): Promise<LogDoc[]> {
    const body = {
      size,
      sort: [{ ts_ms: { order: "desc" } }],
      query: {
        multi_match: { query: text, fields: ["message^2", "log_group", "log_stream"], type: "best_fields" }
      },
      _source: ["id","log_group","log_stream","ts_ms","message"],
    }
    const res = await this.post(`/${encodeURIComponent(indexName)}/_search`, body)
    const hits = (res as any)?.hits?.hits || []
    return hits.map((h: any) => ({id: h._id, ...h._source}))
  }

  async fetchRecent(indexName: string, limit = 50, filter?: {group?: string; stream?: string}): Promise<LogDoc[]> {
    const must: any[] = []
    if (filter?.group) must.push({ term: { log_group: filter.group } })
    if (filter?.stream) must.push({ term: { log_stream: filter.stream } })
    const body = {
      size: limit,
      sort: [{ ts_ms: { order: "desc" } }],
      query: must.length ? { bool: { must } } : { match_all: {} },
      _source: ["id","log_group","log_stream","ts_ms","message"],
    }
    const res = await this.post(`/${encodeURIComponent(indexName)}/_search`, body)
    const hits = (res as any)?.hits?.hits || []
    return hits.map((h: any) => ({id: h._id, ...h._source}))
  }

  async queryRange(indexName: string, fromMs: number, toMs: number, limit: number, minLen = 10): Promise<LogDoc[]> {
    const body = {
      size: Math.max(1, Math.min(1000, limit || 100)),
      sort: [{ ts_ms: { order: "asc" } }],
      query: {
        bool: {
          must: [
            { range: { ts_ms: { gt: fromMs, lte: toMs } } },
            { script: { script: { source: 'doc["message"].value.length() >= params.min', lang: 'painless', params: {min: minLen} } } },
          ],
        },
      },
      _source: ["id","log_group","log_stream","ts_ms","message"],
    }
    const res = await this.post(`/${encodeURIComponent(indexName)}/_search`, body)
    const hits = (res as any)?.hits?.hits || []
    return hits.map((h: any) => ({id: h._id, ...h._source}))
  }

  private async head(path: string): Promise<boolean> {
    const req = new HttpRequest({
      protocol: this.endpointUrl.protocol,
      hostname: this.endpointUrl.hostname,
      path,
      method: "HEAD",
      headers: { host: this.endpointUrl.hostname },
    })
    const signed = await this.signer.sign(req)
    const url = `${this.endpointUrl.origin}${path}`
    const resp = await fetch(url, { method: "HEAD", headers: signed.headers as any })
    return resp.status === 200
  }

  private async put(path: string, body: any): Promise<any> {
    return this.send("PUT", path, body)
  }
  private async post(path: string, body: any, headers?: Record<string,string>): Promise<any> {
    return this.send("POST", path, body, headers)
  }

  private async send(method: "POST"|"PUT", path: string, body: any, extraHeaders?: Record<string,string>): Promise<any> {
    const payload = typeof body === "string" ? body : JSON.stringify(body)
    const req = new HttpRequest({
      protocol: this.endpointUrl.protocol,
      hostname: this.endpointUrl.hostname,
      path,
      method,
      headers: {
        host: this.endpointUrl.hostname,
        "content-type": extraHeaders?.["content-type"] || "application/json",
        ...(extraHeaders || {}),
      },
      body: payload,
    })
    const signed = await this.signer.sign(req)
    const url = `${this.endpointUrl.origin}${path}`
    const resp = await fetch(url, { method, headers: signed.headers as any, body: payload })
    if (!resp.ok) {
      const t = await resp.text()
      throw new Error(`OpenSearch ${method} ${path} failed: ${resp.status} ${resp.statusText} - ${t}`)
    }
    const ct = resp.headers.get("content-type") || ""
    if (ct.includes("application/json")) return await resp.json()
    return await resp.text()
  }
}
