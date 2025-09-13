# AutoIR: Technical Whitepaper

[![TiDB](https://img.shields.io/badge/TiDB-Serverless-red?style=for-the-badge)](https://tidbcloud.com/)
[![AWS SageMaker](https://img.shields.io/badge/AWS-SageMaker-blue?style=for-the-badge&logo=amazonaws&logoColor=white)](https://aws.amazon.com/sagemaker/)
[![AWS ECS Fargate](https://img.shields.io/badge/AWS-ECS%20Fargate-orange?style=for-the-badge&logo=amazonaws&logoColor=white)](https://aws.amazon.com/fargate/)
[![CloudWatch Logs](https://img.shields.io/badge/AWS-CloudWatch_Logs-purple?style=for-the-badge&logo=amazonaws&logoColor=white)](https://aws.amazon.com/cloudwatch/)
[![Kimi K2](https://img.shields.io/badge/Kimi-K2-00D4AA?style=for-the-badge)](https://github.com/KimiLearning/KimiK2)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![oclif](https://img.shields.io/badge/CLI-oclif-0A0A0A?style=for-the-badge)](https://oclif.io/)
[![Real-time Streaming](https://img.shields.io/badge/Streaming-Tokens-yellow?style=for-the-badge)](https://en.wikipedia.org/wiki/Server-sent_events)

## Agentic Incident Response on TiDB + AWS + Kimi K2

![AutoIR Architecture Overview](./media/AutoIR_Architecture_Diagram.png)

Large-scale systems generate massive, noisy logs. Traditional keyword search misses context and brittle alert rules generate fatigue. AutoIR turns raw logs into actionable incidents by combining:

- **TiDB Serverless** with native VECTOR(384) indexing for fast semantic search
- **Serverless embeddings** via AWS SageMaker (HF BGE-small) for low-latency vectorization  
- **Kimi K2 LLM** - An agentic orchestrator with safe function tools to query TiDB and synthesize incidents
- **Optional AWS SNS** notifications for human-in-the-loop routing

Built for the TiDB AgentX Hackathon, AutoIR showcases a real multi-step agent that ingests, embeds, searches, and explains—end to end.

![](./media/AutoIR_Fargate.gif)

## Kimi K2 Integration

![LLM Processing Flow](./diagrams/out/llm_flow.svg)

AutoIR leverages [Kimi K2](https://github.com/KimiLearning/KimiK2), a 32-billion parameter open-source language model developed by Moonshot AI, as its primary LLM for incident analysis and response generation. Kimi K2 provides:

- **32B activated parameters** with 1 trillion total parameters (Mixture-of-Experts architecture)
- **Competitive performance** on knowledge tasks, mathematics, coding, and tool use
- **Quantized deployment** options for cost-effective inference on AWS EC2
- **Native tool calling** support for AutoIR's constrained function toolset

### Deployment Methods

#### 1. AWS EC2 Deployment (Recommended)

AutoIR includes comprehensive tooling for deploying Kimi K2 on AWS EC2 instances using quantized models via [Unsloth's optimized runtime](https://github.com/unslothai/llama.cpp):

```bash
# Setup Kimi K2 instance with quantized model
autoir aws kimi-k2-setup \
  --region us-east-1 \
  --instance-name kimi-k2-prod \
  --instance-type g6.16xlarge \
  --quantization UD-TQ1_0 \
  --storage-size 500
```

**Supported Instance Types:**
- `g6.16xlarge` (recommended) - 64 vCPUs, 256 GB RAM, 4x L4 GPUs
- `g6.12xlarge` - 48 vCPUs, 192 GB RAM, 4x L4 GPUs  
- `g6.8xlarge` - 32 vCPUs, 128 GB RAM, 1x L4 GPU

**Quantization Options:**
- `UD-TQ1_0` (1.8-bit) - Maximum compression, lower accuracy
- `UD-TQ2_K_XL` (2-bit) - Recommended balance of size and performance
- `UD-TQ4_0` (4-bit) - Higher accuracy, larger memory footprint

#### 2. Instance Management

```bash
# List all Kimi K2 endpoints
autoir aws kimi-k2-list --region us-east-1

# Start/stop instances
autoir aws kimi-k2-manage --action start --endpoint kimi-k2-prod
autoir aws kimi-k2-manage --action stop --endpoint kimi-k2-prod

# Check instance status and health
autoir aws kimi-k2-manage --action status --endpoint kimi-k2-prod

# Terminate instance (with confirmation)
autoir aws kimi-k2-manage --action terminate --endpoint kimi-k2-prod --confirm
```

### Chat Interface & Tool Integration

Kimi K2 integrates seamlessly with AutoIR's tool ecosystem for interactive incident analysis:

```bash
# Interactive chat with tool calling enabled
autoir llm chat \
  --endpoint kimi-k2-prod \
  --tools \
  --stream

# Non-interactive analysis
autoir llm chat \
  --endpoint kimi-k2-prod \
  --message "Analyze recent 5xx errors in api-gateway logs" \
  --tools \
  --temperature 60
```

**Available Tools in Chat:**
- `tidb_query` - Execute safe SELECT queries against TiDB
- `analysis` - Perform calculations and data transformations
- `get_current_time` - Time/date utilities for temporal analysis
- `calculate` - Mathematical operations for metrics
- `read_file`/`write_file` - Limited file I/O for reports

### API Format & Integration

AutoIR communicates with Kimi K2 instances via the llama.cpp server API:

```bash
# Direct API call example
curl -X POST http://your-instance-ip:8080/completion \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<|im_system|>system<|im_middle|>You are a systems analyst<|im_end|><|im_user|>user<|im_middle|>Analyze this error<|im_end|><|im_assistant|>assistant<|im_middle|>",
    "temperature": 0.6,
    "min_p": 0.01,
    "n_predict": 500
  }'
```

**Kimi K2 Chat Template Format:**
```
<|im_system|>system<|im_middle|>SYSTEM_PROMPT<|im_end|>
<|im_user|>user<|im_middle|>USER_MESSAGE<|im_end|>
<|im_assistant|>assistant<|im_middle|>
```

### Performance Characteristics

**Typical Performance (g6.16xlarge with UD-TQ1_0):**
- **Inference Speed:** 6-9 tokens/second
- **Context Window:** 16,384 tokens (configurable)
- **Memory Usage:** ~8-12 GB VRAM
- **Cold Start:** ~10-15 seconds
- **Response Latency:** 50-200ms (first token)

**Production Recommendations:**
- Use `UD-TQ2_K_XL` quantization for better accuracy
- Scale to `p4d.24xlarge` for production workloads
- Enable auto-scaling groups for high availability
- Consider multiple regions for disaster recovery

### Cost Optimization

**EC2 Cost Examples (us-east-1):**
- `g6.16xlarge` On-Demand: ~$4.61/hour
- `g6.16xlarge` Reserved (1yr): ~$2.70/hour  
- `g6.12xlarge` Spot: ~$1.50-2.50/hour (varies)

**Cost-Saving Strategies:**
1. **Spot Instances:** 50-70% savings with interruption handling
2. **Reserved Instances:** Up to 42% savings for predictable workloads  
3. **Auto-scheduling:** Stop instances during off-hours
4. **Right-sizing:** Use smaller instances for development/testing

### Security & Access Control

AutoIR's Kimi K2 deployment includes security best practices:

- **Security Groups:** Restrict API access to specific IP ranges
- **IAM Roles:** Least-privilege access for instance management
- **VPC Deployment:** Network isolation with private subnets
- **SSL/TLS:** Encrypted communication (can be configured)
- **Tool Sandboxing:** Constrained function execution environment

```bash
# Setup with custom security configuration
autoir aws kimi-k2-setup \
  --region us-east-1 \
  --instance-name secure-kimi \
  --allowed-ip 203.0.113.0/24 \
  --vpc-id vpc-12345678 \
  --subnet-id subnet-87654321
```

## Core Architecture Pillars

![System Overview](./diagrams/out/overview.svg)

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
# Install globally from npm (recommended)
npm install -g autoir

# Or clone and build from source
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

![Data Pipeline Flow](./diagrams/out/pipeline.svg)

| Data Source | Integration Method | Data Stored |
|-------------|--------------------|-------------|
| CloudWatch Logs | AWS SDK/CLI tailing | Raw messages + metadata |
| Embeddings | SageMaker Serverless (HF DLC) | 384-d vectors (JSON invoke) |
| Vector DB | TiDB Serverless | `VECTOR(384)` column + RDBMS fields |

The agent uses TiDB both for vector search and relational SQL (time filters, aggregations, joins).

## Tool Orchestration Engine

AutoIR implements a sophisticated tool orchestration system that enables safe, constrained function calling for LLM agents:

### Tool Architecture

```typescript
interface Tool {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, any>
    required: string[]
  }
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}
```

### Available Tools & Safeguards

| Tool | Purpose | Safeguards | Example Usage |
|------|---------|------------|---------------|
| `tidb_query` | Read-only SQL to TiDB | SELECT-only, auto-LIMIT 1000, strips semicolons | `SELECT COUNT(*) FROM logs WHERE severity='error'` |
| `analysis` | Pure JS expression eval | Expression-only, no statements, limited stdlib (Math, JSON) | `logs.filter(l => l.timestamp > Date.now() - 3600000).length` |
| `calculate` | Mathematical operations | Blocks constructors/eval, sanitized input | `Math.sqrt(variance) * 2.5` |
| `get_current_time` | Time/date utilities | Timezone validation, ISO format | Returns current timestamp for temporal queries |
| `read_file` | Read local files | Relative paths only, size limits | Read configuration or report files |
| `write_file` | Write local files | Relative paths only, sandbox directory | Generate incident reports |

### Tool Execution Flow

```mermaid
graph LR
    A[LLM Response] --> B{Tool Calls?}
    B -->|Yes| C[Validate Parameters]
    C --> D[Execute Tool]
    D --> E[Collect Results]
    E --> F[Update Conversation]
    F --> G[Send to LLM]
    G --> B
    B -->|No| H[Final Response]
```

The agent's tool cycle implements these safety measures:

1. **Parameter Validation**: All tool calls are validated against JSON schemas
2. **Execution Sandboxing**: Tools run in isolated contexts with limited capabilities
3. **Result Sanitization**: Tool outputs are JSON-serialized and size-limited
4. **Iteration Limits**: Maximum 8 tool cycles to prevent infinite loops
5. **Error Handling**: Tool failures are captured and fed back to the LLM

### Tool Implementation Details

#### TiDB Query Tool
```typescript
// Enforces read-only access with automatic limits
private async execute(args: {sql: string, limit?: number}): Promise<string> {
  if (!/^\s*select\s/i.test(sql)) {
    throw new Error('Only SELECT statements allowed')
  }
  
  const finalSql = hasLimit ? sql : `${sql} LIMIT ${Math.min(limit ?? 100, 1000)}`
  const [rows] = await pool.query(finalSql)
  
  return JSON.stringify({
    rows: Array.isArray(rows) ? rows : [],
    score: Array.isArray(rows) ? rows.length : 0,
    meta: {limit: limit ?? 100, appliedLimit: !hasLimit}
  })
}
```

#### Analysis Tool
```typescript
// Safe expression evaluation in controlled context
private async execute(args: {expression: string, context?: any}): Promise<string> {
  const wrapped = `return (${args.expression});` // Force expression context
  
  try {
    // Provide only safe globals: ctx, Math, JSON
    const fn = new Function('ctx', 'Math', 'JSON', wrapped)
    const result = fn(args.context ?? {}, Math, JSON)
    return JSON.stringify({result})
  } catch (err: any) {
    return JSON.stringify({error: err?.message || String(err)})
  }
}
```

## Streaming Implementation & API Specifications

### Token Streaming Architecture

AutoIR implements real-time streaming for both Kimi K2 and alternative LLM providers:

```typescript
// Streaming interface for real-time token delivery
interface StreamingObserver {
  onStreamStart?: () => void
  onStreamToken?: (token: string) => void
  onStreamEnd?: () => void
  onToolStart?: (call: ToolCall) => void
  onToolResult?: (call: ToolCall, result: string) => void
  onToolError?: (call: ToolCall, error: any) => void
}
```

#### Kimi K2 Streaming Protocol

Kimi K2 streaming uses Server-Sent Events (SSE) or raw JSON lines:

```typescript
// SSE format
data: {"content": "Hello", "delta": "Hello"}
data: {"content": " world", "delta": " world"}
data: [DONE]

// Raw JSON format  
{"content": "Hello"}
{"content": " world"}
```

#### Stream Processing Implementation

```typescript
private async callKimiK2Stream(
  endpoint: string, 
  prompt: string, 
  options: LlmOptions, 
  onToken: (token: string) => void
): Promise<string> {
  const payload = {
    prompt, 
    temperature: options.temperature, 
    min_p: 0.01, 
    n_predict: options.maxTokens, 
    stream: true
  }
  
  return new Promise<string>((resolve) => {
    const child = spawn('curl', [
      '-s', '-N', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(payload),
      `${endpoint}/completion`
    ])
    
    let buffer = ''
    let final = ''
    
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      
      // Process complete lines
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        
        // Handle SSE format: "data: {json}"
        const jsonPart = line.startsWith('data:') 
          ? line.slice(5).trim() 
          : line
          
        if (jsonPart === '[DONE]') {
          child.kill()
          return
        }
        
        try {
          const obj = JSON.parse(jsonPart)
          const token = obj?.content || obj?.delta || ''
          if (token) {
            final += token
            onToken(token)  // Real-time callback
          }
        } catch {
          // Fallback: treat as plain text
          final += jsonPart
          onToken(jsonPart)
        }
      }
    })
    
    child.on('close', () => resolve(final))
  })
}
```

### Prompt Engineering & Message Format

AutoIR uses structured prompt templates with role-based formatting:

#### System Prompt Template
```typescript
export const SYSTEM_PROMPT_TEMPLATE = `You are a senior systems analyst AI agent.
Date: {{TODAY}}

Responsibilities:
1) Investigate system issues by querying TiDB and summarize findings with evidence
2) Propose remediation steps with risk, impact, and rollback strategies  
3) Produce concise, actionable incident insights for SREs and on-call engineers

Guidelines:
- When you need data, call the tidb_query tool with safe SELECT statements
- Always include LIMIT in queries for performance
- Prefer targeted queries with filters and time ranges
- Be explicit about assumptions; update them after seeing data
- Use the analysis tool for calculations or reasoning on retrieved data
- Keep answers structured and succinct
`;
```

#### Message Flow Architecture
```typescript
interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_results?: ToolResult[]
}

// Kimi K2 format conversion
private buildKimiPrompt(messages: LlmMessage[], tools?: Tool[]): string {
  let prompt = ''
  for (const message of messages) {
    switch (message.role) {
      case 'system': 
        prompt += `<|im_system|>system<|im_middle|>${message.content}<|im_end|>`
        break
      case 'user': 
        prompt += `<|im_user|>user<|im_middle|>${message.content}<|im_end|>`
        break
      case 'assistant': 
        prompt += `<|im_assistant|>assistant<|im_middle|>${message.content}<|im_end|>`
        break
      case 'tool': 
        prompt += `<|im_tool|>tool<|im_middle|>${message.content}<|im_end|>`
        break
    }
  }
  
  // Inject tool catalog for self-discovery
  if (tools?.length > 0) {
    const toolsPrompt = `\n\nAvailable tools:\n${tools.map(t => 
      `${t.name}: ${t.description}`
    ).join('\n')}\n\nYou can use tools by calling them with appropriate parameters.`
    
    // Insert before final assistant prompt
    prompt = prompt.replace(
      /(<\|im_user\|>.*?<\|im_end\|>)$/,
      toolsPrompt + '$1'
    )
  }
  
  prompt += `<|im_assistant|>assistant<|im_middle|>`
  return prompt
}
```

### Performance Monitoring & Metrics

AutoIR tracks comprehensive performance metrics:

```typescript
interface PerformanceMetrics {
  // Embedding performance
  embedding_latency_ms: number
  embedding_tokens: number
  embedding_requests_per_minute: number
  
  // Vector search performance  
  vector_search_latency_ms: number
  vector_search_results: number
  vector_search_score_avg: number
  
  // LLM performance
  llm_first_token_latency_ms: number
  llm_tokens_per_second: number
  llm_total_tokens: number
  llm_tool_calls: number
  
  // System performance
  memory_usage_mb: number
  cpu_usage_percent: number
  active_connections: number
}
```

**Typical Performance Characteristics:**
- **SageMaker Embedding Latency**: 50-400ms (serverless cold start)
- **TiDB Vector Search**: <100ms for 10K+ log entries
- **Kimi K2 First Token**: 50-200ms (warm instance)
- **Kimi K2 Throughput**: 6-9 tokens/second (g6.16xlarge)
- **End-to-End Query**: <2s (warm endpoints)
- **Tool Execution**: 10-500ms depending on complexity

## Deployment Targets (Infra)

![Deployment Architecture](./diagrams/out/deployment.svg)

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

### Command Reference

AutoIR provides a comprehensive CLI with commands organized by functional area:

### Main Interface
```bash
# Launch main dashboard (default)
autoir

# Launch search-only interface  
autoir --no-dashboard

# Specify custom endpoints and regions
autoir --sagemaker-endpoint my-embed-ep --region us-west-2
```

### Kimi K2 Management
```bash
# Setup new Kimi K2 instance
autoir aws kimi-k2-setup \
  --region us-east-1 \
  --instance-name kimi-prod \
  --instance-type g6.16xlarge \
  --quantization UD-TQ2_K_XL

# List all Kimi K2 instances
autoir aws kimi-k2-list --region us-east-1

# Manage instance lifecycle
autoir aws kimi-k2-manage --action start --endpoint kimi-prod
autoir aws kimi-k2-manage --action stop --endpoint kimi-prod  
autoir aws kimi-k2-manage --action status --endpoint kimi-prod
autoir aws kimi-k2-manage --action terminate --endpoint kimi-prod --confirm
```

### LLM Chat Interface
```bash
# Interactive chat with tools
autoir llm chat --endpoint kimi-prod --tools --stream

# Single-shot analysis
autoir llm chat \
  --endpoint kimi-prod \
  --message "Analyze recent errors in api-gateway logs" \
  --tools \
  --temperature 60

# Conversation management
autoir llm chat --list-conversations
autoir llm chat --conversation incident-2024-01 --endpoint kimi-prod
autoir llm chat --delete-conversation old-conv-id
autoir llm chat --clear-history
```

### Log Processing & Search
```bash
# Tail and ingest CloudWatch logs
autoir logs tail "/aws/lambda/api-gateway" \
  --region us-east-1 \
  --sagemaker-endpoint embed-ep \
  --embed \
  --follow

# Semantic log search
autoir logs query "database connection timeout" \
  --sagemaker-endpoint embed-ep \
  --sagemaker-region us-east-1 \
  --limit 50 \
  --group "/aws/lambda/*" \
  --since 2h

# Interactive search interface
autoir logs search \
  --sagemaker-endpoint embed-ep \
  --sagemaker-region us-east-1

# Get latest logs (non-semantic)
autoir logs latest "/aws/lambda/api-gateway" \
  --region us-east-1 \
  --limit 100 \
  --since 1h
```

![Search Interface](./diagrams/out/search_ui.svg)

### AWS Infrastructure Management
```bash
# Bootstrap SageMaker embedding endpoint
autoir aws sagemaker-bootstrap \
  --region us-east-1 \
  --endpoint autoir-embed-ep \
  --memory 2048 \
  --concurrency 5

# Deploy ECS Fargate daemon for log ingestion
autoir aws autoir-fargate deploy \
  --cluster autoir \
  --service autoir \
  --region us-east-1 \
  --cpu 512 \
  --memory 1024

# Fargate lifecycle management
autoir aws autoir-fargate status --cluster autoir --service autoir
autoir aws autoir-fargate logs --cluster autoir --log-group /autoir/daemon
autoir aws autoir-fargate start --cluster autoir --service autoir
autoir aws autoir-fargate stop --cluster autoir --service autoir
autoir aws autoir-fargate destroy --cluster autoir --service autoir

# AWS infrastructure health check
autoir aws check --region us-east-1 --profile production
```

### TiDB Configuration
```bash
# Configure TiDB connection interactively
autoir tidb dsn

# Set DSN directly
autoir tidb dsn --dsn mysql://user:pass@host:4000/db

# Show current configuration
autoir tidb dsn --show

# Test connection with custom profile
autoir tidb dsn --name staging
```

### Daemon & Background Processing
```bash
# Run ingestion and alerting daemon (for containers)
autoir daemon \
  --groups "/aws/lambda/api,/aws/ecs/app" \
  --region us-east-1 \
  --sagemaker-endpoint embed-ep \
  --alerts-enabled \
  --sns-topic-arn arn:aws:sns:us-east-1:123:alerts

# With custom alerting thresholds
autoir daemon \
  --alerts-enabled \
  --alerts-interval-sec 300 \
  --alerts-window-min 15 \
  --alerts-min-confidence 70 \
  --alerts-min-severity medium
```

### LLM Configuration
```bash
# Configure LLM provider interactively
autoir llm config

# Switch between providers
autoir llm config --provider aws --endpoint kimi-prod
```

### Global Flags & Options

Most commands support these common flags:

| Flag | Description | Example |
|------|-------------|---------|
| `--region` | AWS region | `--region us-west-2` |
| `--profile` | AWS profile | `--profile production` |
| `--debug` | Enable verbose logging | `--debug` |
| `--dry-run` | Show actions without executing | `--dry-run` |
| `--json` | Output in JSON format | `--json` |
| `--help` | Show command help | `--help` |

### Configuration File Locations

AutoIR stores configuration in your home directory:

```
~/.autoir/
├── config.json              # Main configuration
├── tidb-profiles.json        # TiDB connection profiles  
├── llm-config.json          # LLM provider settings
├── kimi-k2-endpoints.json   # Kimi K2 instance registry
└── conversations/           # Chat conversation history
    ├── conv-uuid-1.json
    └── conv-uuid-2.json
```

## Configuration Guide

### TiDB Setup

#### 1. TiDB Serverless (Recommended)
```bash
# Interactive setup
autoir tidb dsn

# Or provide DSN directly
autoir tidb dsn --dsn mysql://username.root:password@gateway01.us-west-2.prod.aws.tidbcloud.com:4000/database_name
```

#### 2. TiDB Cloud (Dedicated/Essential)
For dedicated clusters requiring CA certificates:
```bash
# Download CA certificate from TiDB Cloud console
# Then configure with CA path
autoir tidb dsn
# Enter CA certificate path when prompted
```

#### 3. Self-Hosted TiDB
```bash
autoir tidb dsn --dsn mysql://root:password@localhost:4000/test
```

### AWS Configuration

#### 1. Prerequisites
```bash
# Install AWS CLI v2
# Configure default credentials
aws configure

# Or use environment variables
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret  
export AWS_REGION=us-east-1
```

#### 2. Required Permissions

AutoIR requires these AWS permissions:

**SageMaker:**
- `sagemaker:CreateModel`
- `sagemaker:CreateEndpointConfig`
- `sagemaker:CreateEndpoint`
- `sagemaker:DescribeEndpoint`
- `sagemaker:InvokeEndpoint`

**EC2 (for Kimi K2):**
- `ec2:RunInstances`
- `ec2:DescribeInstances`
- `ec2:StartInstances`
- `ec2:StopInstances`
- `ec2:TerminateInstances`
- `ec2:CreateSecurityGroup`
- `ec2:AuthorizeSecurityGroupIngress`

**CloudWatch Logs:**
- `logs:DescribeLogGroups`
- `logs:DescribeLogStreams`
- `logs:GetLogEvents`
- `logs:FilterLogEvents`

**ECS (for Fargate):**
- `ecs:CreateCluster`
- `ecs:CreateService`
- `ecs:UpdateService`
- `ecs:DescribeServices`
- `ecs:RegisterTaskDefinition`

**IAM:**
- `iam:CreateRole`
- `iam:AttachRolePolicy`
- `iam:GetRole`
- `iam:PassRole`

#### 3. Cost-Saving Configuration
```bash
# Use spot instances for development
autoir aws kimi-k2-setup \
  --instance-type g6.12xlarge \
  --spot-instance \
  --max-spot-price 2.00

# Scheduled shutdown (via Lambda/EventBridge)
# Stop instances outside business hours
```

### Environment Variables

AutoIR supports these environment variables:

```bash
# TiDB Connection
export TIDB_DSN="mysql://user:pass@host:4000/db"
export TIDB_HOST="gateway01.us-west-2.prod.aws.tidbcloud.com"
export TIDB_PORT=4000
export TIDB_USER="username.root"  
export TIDB_PASSWORD="your_password"
export TIDB_DATABASE="database_name"

# AWS Configuration
export AWS_REGION="us-east-1"
export AWS_PROFILE="production"

# SageMaker
export SAGEMAKER_ENDPOINT="autoir-embed-ep"
export SAGEMAKER_REGION="us-east-1"

# Logging
export LOG_LEVEL="info"
export DEBUG="true"
```

## Local Development
```bash
npm install
npm run build
npm test

# Run a command locally
./bin/run.js logs query --help

# Development with auto-rebuild
npm run dev
```

## RAG & Context Management

- Retrieval: TiDB vector search returns top matches and distances
- Ranking: the agent can further filter via SQL (e.g., time windows) and then synthesize evidence
- Token safety: iterative tool cycles restrict response sizes; only essential rows are returned via LIMIT

## Additional Resources

### Kimi K2 Deployment Guide

For detailed instructions on deploying Kimi K2 on AWS EC2, refer to the comprehensive guide: [Deploying Kimi K2 on Amazon EC2](https://builder.aws.com/content/2zwJtE0MsdmLMtkgOTstKZ0bxgs/deploying-kimi-k2-on-amazon-ec2)

This guide covers:
- EC2 instance setup with Deep Learning AMI
- Unsloth quantized model deployment
- llama.cpp server configuration
- Security group and networking setup
- Performance optimization and cost considerations

### Technical Specifications Summary

| Component | Technology Stack | Key Features |
|-----------|------------------|--------------|
| **Frontend CLI** | Node.js + TypeScript + oclif | Interactive dashboards, streaming interfaces |
| **Vector Database** | TiDB Serverless | Native VECTOR(384), HNSW indexing, cosine distance |
| **Embeddings** | AWS SageMaker Serverless | HF BGE-small-en-v1.5, JSON invocation |
| **LLM Engine** | Kimi K2 (32B MoE) | Quantized deployment, tool calling, streaming |
| **Infrastructure** | AWS (EC2, ECS, CloudWatch) | Serverless and containerized components |
| **Tool System** | Custom orchestration | Safe, constrained function execution |

### Performance Benchmarks

**Production Scale Characteristics:**
- **Log Ingestion Rate:** 1K-10K events/minute per Fargate task
- **Vector Search Latency:** <100ms for 100K+ log entries
- **Incident Analysis Time:** 2-10 seconds end-to-end
- **Concurrent Users:** 10-50 users per Kimi K2 instance
- **Data Retention:** Unlimited (TiDB scales elastically)

### Contributing & Development

AutoIR is designed for extensibility:

1. **Adding New Tools:** Extend `BaseTool` class with proper safety constraints
2. **Custom Embeddings:** Implement alternative embedding providers via SageMaker
3. **Additional LLMs:** Add new providers to `LlmClient` with appropriate prompt formatting
4. **Enhanced Analytics:** Extend SQL queries and analysis functions for domain-specific metrics

For detailed contribution guidelines and development setup, see the [repository](https://github.com/youneslaaroussi/autoir).

## License

MIT
