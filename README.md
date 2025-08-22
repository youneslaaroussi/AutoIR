# AutoIR

[![TiDB](https://img.shields.io/badge/TiDB-Serverless-red?style=for-the-badge)](https://tidbcloud.com/)
[![AWS SageMaker](https://img.shields.io/badge/AWS-SageMaker-blue?style=for-the-badge&logo=amazonaws&logoColor=white)](https://aws.amazon.com/sagemaker/)
[![AWS ECS Fargate](https://img.shields.io/badge/AWS-ECS%20Fargate-orange?style=for-the-badge&logo=amazonaws&logoColor=white)](https://aws.amazon.com/fargate/)
[![CloudWatch Logs](https://img.shields.io/badge/AWS-CloudWatch_Logs-purple?style=for-the-badge&logo=amazonaws&logoColor=white)](https://aws.amazon.com/cloudwatch/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![oclif](https://img.shields.io/badge/CLI-oclif-0A0A0A?style=for-the-badge)](https://oclif.io/)
[![Real-time Streaming](https://img.shields.io/badge/Streaming-Tokens-yellow?style=for-the-badge)](https://en.wikipedia.org/wiki/Server-sent_events)

## Agentic Incident Response on TiDB + AWS

Large-scale systems generate massive, noisy logs. Traditional keyword search misses context and brittle alert rules generate fatigue. AutoIR turns raw logs into actionable incidents by combining:

- TiDB Serverless with native VECTOR(384) indexing for fast semantic search
- Serverless embeddings via AWS SageMaker (HF BGE-small) for low-latency vectorization
- An agentic LLM orchestrator with safe function tools to query TiDB and synthesize incidents
- Optional AWS SNS notifications for human-in-the-loop routing

Built for the TiDB AgentX Hackathon, AutoIR showcases a real multi-step agent that ingests, embeds, searches, and explains—end to end.

## Core Architecture Pillars

- **Vector-native log analytics**: Logs are embedded as 384-d vectors and stored in TiDB with cosine distance for semantic retrieval at query time.
- **Serverless embeddings**: SageMaker Serverless Inference hosts the HF `BAAI/bge-small-en-v1.5` feature-extraction model; cold-start resistant and cost-efficient.
- **Tool-based orchestration**: The agent can call constrained tools (`tidb_query`, `analysis`, etc.) to gather evidence and compute metrics before drafting incidents.
- **Production-ready ingestion**: ECS Fargate daemon tails CloudWatch log groups, batches, embeds, and persists to TiDB.
- **Safety by design**: The TiDB tool only allows SELECTs (LIMIT enforced), and analysis runs as a pure expression evaluator.

## Architecture: Components & Flow

| Component | Purpose | Key Details |
|----------|---------|-------------|
| `CloudWatch Logs` | Raw event source | Any AWS log group/stream |
| `Fargate Daemon` | Ingestion & batching | Pulls logs, optional SNS hooks |
| `SageMaker Endpoint` | Embeddings | HF DLC feature-extraction, serverless, JSON invoke |
| `TiDB Serverless` | Vector store & SQL | `VECTOR(384)`, `vec_cosine_distance`, relational joins |
| `Agent Orchestrator` | LLM + tools | Tool cycle with SELECT-only TiDB queries and safe analysis |

Semantic search happens in-database:

```sql
SELECT id, log_group, log_stream, ts_ms, message,
       1 - (embedding <=> CAST(? AS VECTOR(384))) AS score,
       (embedding <=> CAST(? AS VECTOR(384))) AS distance
FROM `autoir_log_events`
ORDER BY distance ASC
LIMIT 20;
```

And the schema is enforced for vector semantics and incidents:

```sql
CREATE TABLE IF NOT EXISTS `autoir_log_events` (
  id VARCHAR(64) PRIMARY KEY,
  log_group VARCHAR(255),
  log_stream VARCHAR(255),
  ts_ms BIGINT,
  message TEXT,
  embedding VECTOR(384) NOT NULL COMMENT 'hnsw(distance=cosine)',
  KEY idx_group_ts (log_group, ts_ms)
);

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
  UNIQUE KEY uniq_dedupe (dedupe_key)
);
```

## Capability: Multi-step Agentic Analysis

**Example Query:** "Investigate spikes in 5xx errors on `api-gateway` in `us-east-1` over the last hour."

| Step | Tool Called | Result |
|------|-------------|--------|
| 1 | `tidb_query` | Aggregate error-rate by group/stream/time window |
| 2 | `analysis` | Compute severity and confidence based on ratios/volume |
| 3 | `tidb_query` | Fetch representative samples for evidence |
| 4 | (optional) SNS | Notify on-call with concise incident summary |

The agent loops through tools up to 8 times to refine findings before producing a final incident write-up.

## Quick Start

Prerequisites:
- Node.js 18+
- AWS CLI configured with credentials and default region
- TiDB Serverless (or TiDB Cloud) instance

Install:
```bash
# Clone and build
git clone https://github.com/youneslaaroussi/autoir.git
cd autoir
npm install
npm run build

# (Optional) Global install for CLI usage
npm install -g .
```

Configure TiDB and AWS:
```bash
# Save TiDB DSN profile (stores host/user/db locally)
autoir tidb dsn

# Bootstrap a serverless SageMaker embedding endpoint (BGE-small)
autoir aws sagemaker-bootstrap \
  --region us-east-1 \
  --endpoint autoir-embed-ep-srv
```

Ingest logs and store embeddings:
```bash
# Tail CloudWatch, embed lines, and persist vectors into TiDB
autoir logs tail \
  "/aws/lambda/your-log-group" \
  --region us-east-1 \
  --sagemaker-endpoint autoir-embed-ep-srv \
  --embed
```

Query semantically:
```bash
autoir logs query \
  --query "timeout contacting DB" \
  --sagemaker-endpoint autoir-embed-ep-srv
```

Run the agentic incident loop (optional alerts):
```bash
autoir daemon \
  --alerts-enabled \
  --region us-east-1 \
  --sns-arn arn:aws:sns:us-east-1:123456789012:autoir-alerts
```

## Multi-Source Data Pipeline

| Data Source | Integration Method | Data Stored |
|-------------|--------------------|-------------|
| CloudWatch Logs | AWS SDK/CLI tailing | Raw messages + metadata |
| Embeddings | SageMaker Serverless (HF DLC) | 384-d vectors (JSON invoke) |
| Vector DB | TiDB Serverless | `VECTOR(384)` column + RDBMS fields |

The agent uses TiDB both for vector search and relational SQL (time filters, aggregations, joins).

## Tool Orchestration Engine

AutoIR exposes a constrained set of tools for safe, explainable agent behavior:

| Tool | Purpose | Safeguards |
|------|---------|------------|
| `tidb_query` | Read-only SQL to TiDB | SELECT-only, strips semicolons, auto-LIMIT |
| `analysis` | Pure JS expression eval for math/data shaping | Expression-only, limited stdlib |
| `calculate` | Sanitized math evaluator | Blocks constructors/eval |
| `get_current_time` | Time helpers | Timezone validation |
| `read_file` / `write_file` | Minimal file IO | Relative paths, basic checks |

The agent’s tool cycle reconciles tool outputs back into the conversation, iterating until no further tool calls are returned or a max step limit is reached.

## Streaming & Reasoning

- Token streaming: the AWS-backed endpoint streams content chunks that the CLI displays in real-time.
- Prompt format: role-tagged blocks (`<|im_system|>`, `<|im_user|>`, `<|im_assistant|>`, `<|im_tool|>`) with an injected tools catalog for self-discovery.
- System prompt frames responsibilities, encourages targeted TiDB queries, and mandates LIMIT usage.

## Deployment Targets (Infra)

- **SageMaker Serverless Inference**: provisions execution role, registers HF DLC, creates endpoint-config and endpoint; waits until `InService` and performs a sample invoke.
- **ECS Fargate Daemon**: optional command deploys a log ingestion task that pushes vectors into TiDB and emits metrics.
- **CloudWatch + SNS**: querying recent windows and publishing incident summaries to SNS for paging/triage.

## Technical Specifications

| Component | Technology | Notes |
|-----------|------------|-------|
| Backend | Node.js + TypeScript (oclif) | Modular commands & libraries |
| Vector DB | TiDB Serverless | `VECTOR(384)`, cosine distance, HNSW comment |
| Embeddings | SageMaker Serverless Inference | HF `BAAI/bge-small-en-v1.5` feature-extraction |
| Agent Orchestration | Tool-calling loop | SELECT-only DB tool, safe analysis tool |
| AWS Integrations | CloudWatch Logs, ECS Fargate, SNS | Operational glue |

Performance profile (typical):
- Embedding latency (serverless): 50–400 ms per request body
- Vector search (TiDB): sub-100 ms for tens of thousands of rows
- End-to-end semantic query: < 2 s with warm endpoints

## Cost Notes (Typical Dev Settings)

- TiDB Serverless: generous free tier; scales elastically
- SageMaker Serverless Inference: pay-per-invocation (memory × duration)
- ECS Fargate: per-task vCPU/GB-hr, often minimal for a single daemon
- CloudWatch + SNS: low cost unless tailing very high-volume groups

## Codebase Architecture & Contribution Guide

### Repository Structure

```
src/
├── commands/           # oclif commands (aws, logs, llm, tidb, daemon)
├── lib/                # shared libraries
│   ├── db.ts           # schema, incident upsert, cursor tracking
│   ├── llm/            # agent client (tool-calling, streaming)
│   ├── tools/          # tool registry + tool implementations
│   └── config.ts       # persisted app config (TiDB, LLM, Fargate)
└── prompts/            # system prompt template
```

### Adding a New Tool
1. Create a class in `src/lib/tools/` extending `BaseTool`
2. Register it in `ToolManager`
3. Keep side-effects out, prefer read-only operations
4. Provide a concise JSON schema for parameters

### Local Development
```bash
npm install
npm run build
npm test

# Run a command locally
./bin/run.js logs query --help
```

## RAG & Context Management

- Retrieval: TiDB vector search returns top matches and distances
- Ranking: the agent can further filter via SQL (e.g., time windows) and then synthesize evidence
- Token safety: iterative tool cycles restrict response sizes; only essential rows are returned via LIMIT

## TiDB AgentX Hackathon Submission Guide

- **TiDB Cloud Account Email**: <your-email@domain.com>
- **Repository URL**: <public GitHub URL>
- **Data Flow Summary**: CloudWatch → Fargate tail → SageMaker embeddings → TiDB VECTOR(384) → Agent tools (TiDB query + analysis) → Incident records + optional SNS
- **Run Instructions**: See Quick Start (TiDB DSN setup, SageMaker bootstrap, tail, query, daemon)
- **Project Description**: Agentic incident response on TiDB + AWS with vector-native search and tool calling
- **Demo Video**: <link>

## License

MIT
