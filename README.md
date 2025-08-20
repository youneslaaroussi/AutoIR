## AutoIR — AI Agents for Incident Reporting on AWS (TiDB + Kimi K2)

<img alt="High-level technical diagram: CloudWatch Logs -> AutoIR (daemon/TUI) -> SageMaker embeddings -> TiDB VECTOR(384) -> LLM analysis (Kimi K2/OpenAI) -> Alerts (Slack/SNS)" />

### Overview
AutoIR is a developer-first CLI that ingests AWS CloudWatch Logs, generates embeddings via Amazon SageMaker, stores vectors in TiDB for semantic search, and runs an LLM assistant (Kimi K2 on AWS or OpenAI) to summarize incidents and notify on-call via Slack or SNS. It includes an interactive TUI for live search and a Fargate deployment to run the ingestion/analysis daemon continuously.

AutoIR is built on oclif and ships commands to: bootstrap a SageMaker embedding endpoint, configure TiDB, tail CloudWatch logs into TiDB with VECTOR(384), run semantic search, deploy a small "noise" ECS service to generate test logs, deploy a daemon on ECS Fargate, manage a self-hosted Kimi K2 EC2 endpoint, and chat with the LLM.

### Technology chips
- **CLI framework**: oclif
- **Database**: TiDB with VECTOR(384) column and HNSW index hints
- **AWS services**: CloudWatch Logs, SageMaker (serverless inference), ECS Fargate, ECR, IAM, STS, SNS
- **LLM backends**: AWS self-hosted Kimi K2 endpoint or OpenAI
- **Alerting**: Slack Incoming Webhooks and Amazon SNS
- **UI**: Terminal UIs with blessed and blessed-contrib

<img alt="Screenshot placeholder: semantic search TUI with query box, result list, and details pane" />

## Prerequisites
- **Node.js 18+** (CLI runtime)
- **AWS CLI v2** installed and authenticated for the target account (`autoir aws check` can verify)
- **TiDB** cluster reachable from where you run AutoIR. For TiDB Cloud Dedicated/Serverless, use TLS.
  - The logs table stores `VECTOR(384)` embeddings; server-side vector search uses cosine distance.
- **Embedding endpoint**: an Amazon SageMaker endpoint for sentence embeddings (the CLI can bootstrap a serverless endpoint).
- Optional: **Slack Incoming Webhook** for alerts, **Amazon SNS Topic ARN** for alerts, and an **LLM endpoint** (Kimi K2 on EC2) or OpenAI API key for analysis and chat.

<img alt="Screenshot placeholder: AutoIR startup screen showing TiDB connection and AWS test" />

## Installation
### From source (recommended for now)
```bash
git clone https://github.com/youneslaaroussi/autoir.git
cd autoir
pnpm install
pnpm build
# Run via local bin
./bin/run.js --help
```

### Global install from a local build (optional)
```bash
# Inside repo root after build
npm pack
npm install -g ./autoir-*.tgz
autoir --version
```

<img alt="Screenshot placeholder: terminal showing 'autoir --help'" />

## Quick start usage
Below are proven commands directly from this repository.

- **Verify AWS CLI/auth**
```bash
autoir aws check
```

- **Authenticate with TiDB Cloud (via ticloud)**
```bash
autoir tidb oauth
```

- **Set or show TiDB DSN profile**
```bash
autoir tidb dsn                       # interactive
autoir tidb dsn --show                # print current saved profile
autoir tidb dsn --dsn mysql://user:pass@host:4000/db
```

- **Bootstrap a SageMaker serverless embedding endpoint**
```bash
autoir aws sagemaker-bootstrap -r us-east-1 --endpoint autoir-embed-ep
```

- **Tail a CloudWatch Logs group, embed, and write to TiDB**
```bash
autoir logs tail /aws/lambda/my-func \
  --region us-east-1 \
  --sagemaker-endpoint autoir-embed-ep \
  --sagemaker-region us-east-1
```

- **Run semantic vector search (non-interactive)**
```bash
autoir logs query "payment timeout" \
  --sagemaker-endpoint autoir-embed-ep --sagemaker-region us-east-1
```

- **Interactive semantic search TUI**
```bash
autoir logs search \
  --sagemaker-endpoint autoir-embed-ep --sagemaker-region us-east-1
```

- **Open the main TUI (dashboard or search)**
```bash
autoir --sagemaker-endpoint autoir-embed-ep --dashboard
```

- **Kimi K2/OpenAI configuration and chat**
```bash
autoir llm config                     # choose provider; select default Kimi K2 endpoint or set OpenAI key
autoir llm chat --endpoint my-kimi-k2 # chat with saved Kimi K2 endpoint
```

<img alt="Screenshot placeholder: Fargate dashboard with service metrics and tasks" />

## End-to-end live walkthrough
This example uses the built-in "noise" ECS service to generate logs, deploys the AutoIR daemon on Fargate, opens a dashboard, performs searches, chats with the LLM, and sends alerts to Slack.

1) Create test logs with a tiny ECS service (CloudFormation)
```bash
autoir aws logs-noise deploy --region us-east-1 --cluster autoir --service autoir-noise
# This creates a log group (default: /autoir/noise)
```

2) Deploy the AutoIR daemon on ECS Fargate (CloudFormation)
```bash
autoir aws autoir-fargate deploy \
  --region us-east-1 \
  --cluster autoir \
  --service autoir \
  --daemon-log-groups /autoir/noise \
  --sagemaker-endpoint autoir-embed-ep --sagemaker-region us-east-1 \
  --alertsEnabled \
  --alertsChannels slack \
  --slack-webhook-url https://hooks.slack.com/services/XXX/YYY/ZZZ
```

3) Open the live dashboard
```bash
autoir --dashboard --region us-east-1 --cluster autoir --service autoir --sagemaker-endpoint autoir-embed-ep
```

4) Manually explore logs with semantic search and direct queries
```bash
autoir logs search --sagemaker-endpoint autoir-embed-ep --sagemaker-region us-east-1
autoir logs query "deadlock detected" --sagemaker-endpoint autoir-embed-ep --sagemaker-region us-east-1
```

5) Chat with the LLM and use tools
```bash
autoir llm config
autoir llm chat --endpoint my-kimi-k2 --stream
```

6) Receive alerts in Slack (and/or SNS)
- Provided by the daemon when `--alertsEnabled` and `--alertsChannels slack` and `--slack-webhook-url` are set.

<img alt="Screenshot placeholder: Slack channel showing incident summary with severity and confidence" />

## Commands reference (selected)
Use `--help` on any command for full details.

- `autoir aws check`
- `autoir tidb oauth`
- `autoir tidb dsn [--dsn | --show]`
- `autoir aws sagemaker-bootstrap -r <region> --endpoint <name>`
- `autoir logs tail <group> [--sagemaker-endpoint <name>]`
- `autoir logs query <text> --sagemaker-endpoint <name>`
- `autoir logs search --sagemaker-endpoint <name>`
- `autoir aws logs-noise <deploy|status|logs|start|stop|destroy>`
- `autoir aws autoir-fargate <deploy|status|logs|start|stop|destroy>`
- `autoir aws kimi-k2-setup` / `autoir aws kimi-k2-manage` / `autoir aws kimi-k2-list`
- `autoir llm config` / `autoir llm chat`

<img alt="Screenshot placeholder: command help output for 'autoir logs tail'" />

## Technical details

### Data model and vector search
- Logs table (created automatically when needed):
  - `id VARCHAR(64) PRIMARY KEY`
  - `log_group VARCHAR(255)`, `log_stream VARCHAR(255)`, `ts_ms BIGINT`, `message TEXT`
  - `embedding VECTOR(384) NOT NULL COMMENT 'hnsw(distance=cosine)'`
  - Secondary indexes for common filters
- Incident table with de-duplication by `dedupe_key` for alerting.

### Embeddings and inference
- Default example uses an HF CPU DLC on SageMaker Serverless with `HF_TASK=feature-extraction` (endpoint created by `aws sagemaker-bootstrap`).
- The CLI generates query embeddings client-side for `logs query` and stores event embeddings during `logs tail`.

### LLM providers
- AWS self-hosted Kimi K2 endpoint on EC2 (managed by `aws kimi-k2-setup` / `aws kimi-k2-manage` / stored in `~/.autoir/kimi-k2-endpoints.json`).
- OpenAI as an alternative provider via `llm config` with `OPENAI_API_KEY`.

### Deployment architecture (ECS Fargate)
- Containerized daemon tails CloudWatch groups via AWS CLI, invokes SageMaker for embeddings, writes to TiDB, and runs an LLM-based alert loop.
- Configurable alert channels: Slack Webhook and SNS Topic.

<img alt="Architecture diagram placeholder: ECS service running daemon; env includes LOG_GROUPS, SAGEMAKER_ENDPOINT, TIDB_DSN; outputs to TiDB and Slack/SNS" />

### Cost breakdown (indicative)
| Component | Notes | How to limit cost |
|---|---|---|
| TiDB Cloud | VECTOR search with HNSW; billable RUs and storage | Lower ingestion rates, prune retention, pause tails |
| SageMaker Serverless | Per-request + provisioned concurrency | Delete or scale down endpoint when idle |
| ECS Fargate | Per vCPU/GB-hour; CloudWatch Logs | `autoir aws autoir-fargate stop` (DesiredCount=0) or `destroy` |
| EC2 (Kimi K2) | GPU hourly cost + EBS | `autoir aws kimi-k2-manage stop` or `terminate` |
| Slack/SNS | Typically negligible | Disable alerts or use `--alerts-dry-run` locally |

### Immediate stop/pause controls
- Ingestion: `autoir aws autoir-fargate stop` (sets desired count to 0) or `destroy`.
- Test generator: `autoir aws logs-noise stop` or `destroy`.
- Kimi K2: `autoir aws kimi-k2-manage stop` or `terminate`.
- Local daemon: Ctrl-C.

## Future plans and business use cases
| Area | Plan | Business value |
|---|---|---|
| Detection | Deeper heuristics + retrieval-augmented analysis | Faster MTTR with higher confidence summaries |
| UI | Web dashboard (metrics, incidents, traces) | Centralized observability for SRE/on-call |
| Ingestion | Turn-key sources (ALB, Lambda, ECS, EKS) | Broader coverage with minimal setup |
| Cost control | Autoscaling and sleep modes | Cost-aware, burst-on-demand operations |

<img alt="Product mockup placeholder: web dashboard with incidents timeline and vector search panel" />

## Citations and references
- TiDB vector search via SQL (VECTOR type, HNSW): [docs.pingcap.com/tidb/v8.5/vector-search-get-started-using-sql](https://docs.pingcap.com/tidb/v8.5/vector-search-get-started-using-sql/)
- TiDB Cloud CLI (ticloud): [docs.pingcap.com/tidbcloud/cli](https://docs.pingcap.com/tidbcloud/cli)
- AWS CloudWatch Logs tail (AWS CLI): [docs.aws.amazon.com/cli/latest/reference/logs/tail.html](https://docs.aws.amazon.com/cli/latest/reference/logs/tail.html)
- Amazon SageMaker serverless inference: [docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html)
- Amazon ECS on AWS Fargate: [docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- Slack Incoming Webhooks: [api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks)

<img alt="Appendix placeholder: command tree and help excerpts" />

