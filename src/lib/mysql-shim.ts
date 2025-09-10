import path from 'node:path'
import os from 'node:os'
import {promises as fs} from 'node:fs'
import {LocalIndex} from 'vectra'

// Minimal types to satisfy existing generics/usages
export type RowDataPacket = Record<string, any>

type QueryResult = [any[], any]

type Connection = {
	execute: (sql: string, params?: any[]) => Promise<QueryResult>
	release: () => void
}

type Pool = {
	query: (sql: string, params?: any[]) => Promise<QueryResult>
	getConnection: () => Promise<Connection>
	end: () => Promise<void>
}

type CreatePoolOptions = {
	host: string
	port?: number
	user: string
	password?: string
	database: string
	waitForConnections?: boolean
	connectionLimit?: number
	ssl?: any
}

function getBaseDir(): string {
	const dir = path.join(os.homedir(), '.autoir', 'vectra')
	return dir
}

async function ensureDir(p: string): Promise<void> {
	await fs.mkdir(p, {recursive: true})
}

async function readJson<T>(file: string, def: T): Promise<T> {
	try { const raw = await fs.readFile(file, 'utf8'); return JSON.parse(raw) as T } catch { return def }
}

async function writeJson(file: string, data: any): Promise<void> {
	await ensureDir(path.dirname(file))
	await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) { const x = a[i] || 0, y = b[i] || 0; dot += x*y; na += x*x; nb += y*y }
	if (na === 0 || nb === 0) return 0
	return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function getIndexPath(opts: CreatePoolOptions, table: string): string {
	return path.join(getBaseDir(), encodeURIComponent(opts.host+':' + (opts.port||0)), encodeURIComponent(opts.database), encodeURIComponent(table))
}

function createVectraIndex(indexPath: string): LocalIndex {
	return new LocalIndex(indexPath)
}

async function ensureIndex(index: LocalIndex): Promise<void> {
	if (!(await index.isIndexCreated())) {
		await ensureDir(path.dirname((index as any).indexPath || indexPathFromIndex(index)))
		await index.createIndex()
	}
}

function indexPathFromIndex(index: any): string {
	// best-effort; not part of public API
	return index?._indexPath || index?.indexPath || ''
}

async function readIndexItems(indexPath: string): Promise<Array<{vector: number[]; metadata: any}>> {
	const file = path.join(indexPath, 'index.json')
	try {
		const raw = await fs.readFile(file, 'utf8')
		const data = JSON.parse(raw)
		const items = Array.isArray(data?.items) ? data.items : []
		return items.map((it: any) => ({ vector: Array.isArray(it?.vector) ? it.vector : [], metadata: it?.metadata || {} }))
	} catch {
		return []
	}
}

export function createPool(opts: CreatePoolOptions): Pool {
	const incidentsFile = path.join(getBaseDir(), 'meta', 'incidents.json')
	const cursorsFile = path.join(getBaseDir(), 'meta', 'cursors.json')

	const api = {
		async query(sql: string, params: any[] = []): Promise<QueryResult> {
			const s = String(sql || '')
			// 1) CREATE TABLE ... → no-op
			if (/^\s*create\s+table\s+/i.test(s)) {
				return [[], undefined]
			}
			// 2) INFORMATION_SCHEMA column type check for 'embedding'
			if (/information_schema\.columns/i.test(s) && /column_name\s*=\s*'embedding'/i.test(s)) {
				return [[{DATA_TYPE: 'vector'}], undefined]
			}
			// Extract table name if present as FROM `table` or INTO `table`
			const tableMatch = /\bfrom\s+`([^`]+)`|\binsert\s+into\s+`([^`]+)`/i.exec(s)
			const table = tableMatch ? (tableMatch[1] || tableMatch[2]) : undefined

			// 3) INSERT into logs table with CAST(? AS VECTOR(384))
			if (/^\s*insert\s+into\s+/i.test(s) && /\bembedding\b/i.test(s)) {
				if (!table) return [[], undefined]
				const indexPath = getIndexPath(opts, table)
				const index = createVectraIndex(indexPath)
				await ensureIndex(index)
				// Values: (id, log_group, log_stream, ts_ms, message, embedding)
				const [id, log_group, log_stream, ts_ms, message, embeddingJson] = params
				let vector: number[] = []
				try { vector = JSON.parse(String(embeddingJson || '[]')) } catch { vector = [] }
				await index.insertItem({
					vector,
					metadata: { id, log_group, log_stream, ts_ms: Number(ts_ms), message: String(message || '') }
				})
				return [[], undefined]
			}

			// 4) Vector search using vec_cosine_distance(embedding, CAST(? AS VECTOR(384)))
			if (/vec_cosine_distance\s*\(/i.test(s) || /embedding\s*<=>\s*cast\(/i.test(s)) {
				if (!table) return [[], undefined]
				const indexPath = getIndexPath(opts, table)
				const index = createVectraIndex(indexPath)
				await ensureIndex(index)
				// params typically: [qVecJson or two times, minLen?, group?, since?, limit]
				// Extract the first JSON vector param
				let qVec: number[] = []
				for (const p of params) {
					if (typeof p === 'string' && (p.startsWith('[') || p.startsWith('{'))) { try { const v = JSON.parse(p); if (Array.isArray(v)) { qVec = v; break } } catch {} }
				}
				const limit = (() => { const n = params[params.length - 1]; return Number.isFinite(n) ? Number(n) : 20 })()
				const whereGroupMatch = /\blog_group\s*=\s*\?/i.test(s)
				const whereSinceMatch = /\bts_ms\s*>=\s*\?/i.test(s)
				let paramIdx = 0
				// Skip vector param(s)
				paramIdx += (s.match(/cast\(/gi)?.length || 1)
				const minLenIncluded = /char_length\(message\)\s*>=\s*\?/i.test(s)
				if (minLenIncluded) paramIdx += 1
				let group: string | undefined
				if (whereGroupMatch) { group = params[paramIdx++]; }
				let sinceMs: number | undefined
				if (whereSinceMatch) { sinceMs = Number(params[paramIdx++]); }
				const all = await readIndexItems(indexPath)
				let items = all.map((it: any) => ({
					id: String(it.metadata?.id || ''),
					log_group: String(it.metadata?.log_group || ''),
					log_stream: String(it.metadata?.log_stream || ''),
					ts_ms: Number(it.metadata?.ts_ms || 0),
					message: String(it.metadata?.message || ''),
					vector: it.vector as number[]
				})) as Array<{id: string; log_group: string; log_stream: string; ts_ms: number; message: string; vector: number[]}>
				if (group) items = items.filter((r: {log_group: string}) => r.log_group === group)
				if (sinceMs) items = items.filter((r: {ts_ms: number}) => r.ts_ms >= (sinceMs as number))
				// Score by cosine similarity and convert to distance ASC
				const withScore = items.map((r) => ({...r, distance: 1 - cosineSimilarity(r.vector || [], qVec)}))
				withScore.sort((a,b) => a.distance - b.distance)
				const rows = withScore.slice(0, limit).map((r) => ({ id: r.id, log_group: r.log_group, log_stream: r.log_stream, ts_ms: r.ts_ms, message: r.message, distance: r.distance }))
				return [rows, undefined]
			}

			// 5) Plain selects over logs table time range
			if (/select\s+id\s*,\s*log_group\s*,\s*log_stream\s*,\s*ts_ms\s*,\s*message\s*from\s+`[^`]+`/i.test(s)) {
				if (!table) return [[], undefined]
				const indexPath = getIndexPath(opts, table)
				const index = createVectraIndex(indexPath)
				await ensureIndex(index)
				const all = await readIndexItems(indexPath)
				let items = all.map((it: any) => ({ id: String(it.metadata?.id || ''), log_group: String(it.metadata?.log_group || ''), log_stream: String(it.metadata?.log_stream || ''), ts_ms: Number(it.metadata?.ts_ms || 0), message: String(it.metadata?.message || '') })) as Array<{id: string; log_group: string; log_stream: string; ts_ms: number; message: string}>
				// WHERE ts_ms > ? AND ts_ms <= ? ... LIMIT ?
				const tsStart = Number(params[0] || 0)
				const tsEnd = Number(params[1] || Date.now())
				const limit = Number(params[3] || 1000)
				items = items.filter((r) => r.ts_ms > tsStart && r.ts_ms <= tsEnd)
				items.sort((a,b)=> a.ts_ms - b.ts_ms)
				return [items.slice(0, limit), undefined]
			}

			// 5b) Recent logs screen: SELECT log_group, log_stream, ts_ms, message ... ORDER BY ts_ms DESC LIMIT 50 with optional LIKE
			if (/select\s+log_group\s*,\s*log_stream\s*,\s*ts_ms\s*,\s*message\s*from\s+`[^`]+`/i.test(s)) {
				if (!table) return [[], undefined]
				const indexPath = getIndexPath(opts, table)
				const index = createVectraIndex(indexPath)
				await ensureIndex(index)
				const all = await readIndexItems(indexPath)
				let items = all.map((it: any) => ({ log_group: String(it.metadata?.log_group || ''), log_stream: String(it.metadata?.log_stream || ''), ts_ms: Number(it.metadata?.ts_ms || 0), message: String(it.metadata?.message || '') })) as Array<{log_group: string; log_stream: string; ts_ms: number; message: string}>
				if (/\bwhere\b/i.test(s) && /like\s*\?/i.test(s)) {
					const like1 = String(params[0] || '').replace(/%/g, '').toLowerCase()
					const like2 = String(params[1] || '').replace(/%/g, '').toLowerCase()
					const like3 = String(params[2] || '').replace(/%/g, '').toLowerCase()
					items = items.filter((r) => r.log_group.toLowerCase().includes(like1) || r.log_stream.toLowerCase().includes(like2) || r.message.toLowerCase().includes(like3))
				}
				items.sort((a,b)=> b.ts_ms - a.ts_ms)
				const limMatch = /\blimit\s+(\d+)/i.exec(s)
				const lim = limMatch ? Number(limMatch[1]) : 50
				return [items.slice(0, lim), undefined]
			}

			// 6) Incidents and cursors (JSON-backed)
			if (/\sfrom\s+autoir_incidents\b/i.test(s) && /\bdedupe_key\s*=\s*\?/i.test(s)) {
				const wanted = String(params[0] || '')
				const data = await readJson<{items: any[]}>(incidentsFile, {items: []})
				const found = data.items.find(x => x.dedupe_key === wanted)
				return [found ? [{id: found.id}] : [], undefined]
			}
			if (/^\s*update\s+autoir_incidents\b/i.test(s)) {
				// Update by id at the end
				const id = String(params[params.length - 1])
				const data = await readJson<{items: any[]}>(incidentsFile, {items: []})
				const idx = data.items.findIndex(x => x.id === id)
				if (idx >= 0) {
					// Map known params by position from lib/db.ts
					const [updated_ms, last_ts_ms, add_count, summary, affected_group, affected_stream, vector_context] = params.slice(0,7)
					const cur = data.items[idx]
					cur.updated_ms = Number(updated_ms)
					cur.last_ts_ms = Math.max(Number(cur.last_ts_ms || 0), Number(last_ts_ms || 0))
					cur.event_count = Number(cur.event_count || 0) + Number(add_count || 0)
					if (summary != null) cur.summary = summary
					if (affected_group != null) cur.affected_group = affected_group
					if (affected_stream != null) cur.affected_stream = affected_stream
					if (vector_context != null) { try { cur.vector_context = JSON.parse(String(vector_context)) } catch { cur.vector_context = vector_context } }
					await writeJson(incidentsFile, data)
				}
				return [[], undefined]
			}
			if (/^\s*insert\s+into\s+autoir_incidents\b/i.test(s)) {
				const data = await readJson<{items: any[]}>(incidentsFile, {items: []})
				const [id, created_ms, updated_ms, status, severity, title, summary, affected_group, affected_stream, first_ts_ms, last_ts_ms, event_count, sample_ids, vector_context, dedupe_key] = params
				const item = {
					id: String(id), created_ms: Number(created_ms), updated_ms: Number(updated_ms), status, severity, title,
					summary: summary ?? null, affected_group: affected_group ?? null, affected_stream: affected_stream ?? null,
					first_ts_ms: first_ts_ms ?? null, last_ts_ms: last_ts_ms ?? null, event_count: Number(event_count||0),
					sample_ids: sample_ids ? JSON.parse(String(sample_ids)) : null,
					vector_context: vector_context ? JSON.parse(String(vector_context)) : null,
					dedupe_key: String(dedupe_key)
				}
				data.items.push(item)
				await writeJson(incidentsFile, data)
				return [[], undefined]
			}
			if (/\sfrom\s+autoir_cursors\b/i.test(s)) {
				const id = String(params[0] || '')
				const data = await readJson<Record<string, {last_ts_ms: number; last_id?: string}>>(cursorsFile, {})
				const rec = data[id]
				return [rec ? [{last_ts_ms: Number(rec.last_ts_ms)}] : [], undefined]
			}
			if (/^\s*insert\s+into\s+autoir_cursors\b/i.test(s)) {
				const [pipeline_id, last_ts_ms, last_id] = params
				const data = await readJson<Record<string, {last_ts_ms: number; last_id?: string}>>(cursorsFile, {})
				data[String(pipeline_id)] = {last_ts_ms: Number(last_ts_ms || 0), last_id: last_id ? String(last_id) : undefined}
				await writeJson(cursorsFile, data)
				return [[], undefined]
			}

			// Default: return empty
			return [[], undefined]
		},
		async getConnection(): Promise<Connection> {
			return {
				execute: async (sql: string, params?: any[]) => api.query(sql, params),
				release: () => {}
			}
		},
		async end(): Promise<void> { /* noop */ }
	}
	return api
}

// Use an 'any' default export to preserve compatibility with code that references mysql.RowDataPacket types.
const mysqlShim: any = { createPool }
export default mysqlShim

