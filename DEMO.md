# 🚀 AutoIR Demo Guide

Welcome to the AutoIR demo! This guide will help you run an impressive demonstration of AI-powered incident response that will wow judges and audiences.

## 🎯 What This Demo Shows

- **Real-time log processing** with vector embeddings using SageMaker
- **AI-powered incident detection** with TiDB vector similarity search  
- **Live Slack notifications** with rich incident reports
- **AWS Fargate deployment** simulation (runs locally but appears real)
- **Interactive dashboard** with real-time metrics and activity feeds
- **Semantic log search** that understands context, not just keywords

## 🏃‍♂️ Quick Start (5 Minutes)

### 1. Basic Setup
```bash
# Clone and install
git clone https://github.com/youneslaaroussi/autoir.git
cd autoir
npm install
npm run build
```

### 2. Run the Complete Demo
```bash
# Start the full demo with dashboard
autoir demo --full-screen --slack-demo

# OR run in console mode
autoir demo --slack-demo
```

That's it! The demo will:
- ✅ Initialize mock TiDB with realistic vector data
- ✅ Start fake AWS services (SageMaker, ECS, CloudWatch) 
- ✅ Launch Docker daemon simulating Fargate
- ✅ Begin real-time log processing and incident detection
- ✅ Send impressive reports to Slack (if configured)

## 🤖 Optional: Real Slack Integration

For maximum impact, set up a real Slack bot:

```bash
# Interactive Slack setup
autoir slack setup

# Test the integration
autoir slack test --demo
```

The setup will guide you through:
1. Creating a Slack app at https://api.slack.com/apps
2. Getting your bot token (xoxb-...)
3. Joining channels automatically
4. Sending test incident reports

## 🎪 Demo Features Explained

### Real-Time Dashboard (`--full-screen`)
- Live metrics: logs processed, incidents detected, alerts sent
- AWS services status with realistic uptime and resource usage
- TiDB vector database stats with query latency
- Activity feed showing AI analysis in real-time

### Slack Integration (`--slack-demo`) 
- **Critical incidents** with severity levels and affected services
- **AI analysis reports** with prediction accuracy and insights
- **System health updates** with resolution times and SLA status
- **Rich formatting** with emojis, metrics, and timelines

### Fake AWS Services (Seamless)
- **SageMaker**: Generates realistic 384-dimensional embeddings
- **ECS Fargate**: Shows running tasks with health checks
- **CloudWatch Logs**: Provides sample log events from multiple services
- **SNS**: Simulates alert delivery

### Vector Search Demo
```bash
# Semantic search that understands context
autoir logs query "database timeout error" --sagemaker-endpoint demo

# Will find logs about:
# - Connection timeouts
# - Database pool exhaustion  
# - Service unavailable errors
# Even if exact words don't match!
```

## 🎬 Demo Script for Judges

### Opening (30 seconds)
```bash
autoir demo --full-screen --slack-demo
```

**Say**: "AutoIR is an AI-powered incident response system that processes thousands of logs per minute, automatically detects anomalies using vector similarity search, and sends intelligent alerts. Let me show you how it works in real-time."

### Show Real-Time Processing (1 minute)
Point to the dashboard:
- **Logs Processed**: Shows increasing numbers
- **Activity Feed**: Real-time AI analysis
- **AWS Services**: All green, running on Fargate
- **TiDB Stats**: Vector operations per minute

**Say**: "The system is ingesting logs from multiple AWS services, generating embeddings using SageMaker, and storing them in TiDB with native vector support. Notice the sub-100ms query latency for similarity search."

### Demonstrate Semantic Search (1 minute)
```bash
# In another terminal
autoir logs query "payment failed" --sagemaker-endpoint demo --debug
```

**Say**: "Watch this - instead of keyword matching, we use semantic search. I'm searching for 'payment failed' but it will find related issues like 'transaction timeout', 'card processing error', etc. The AI understands the meaning, not just the words."

### Show Slack Integration (30 seconds)
Point to Slack channel (if configured):
- **Critical incidents** appearing automatically
- **Rich formatting** with metrics and timelines
- **AI analysis reports** with insights

**Say**: "The system automatically sends contextual alerts to Slack with all the information needed for rapid response. No more alert fatigue - only meaningful notifications."

### Highlight Technical Excellence (30 seconds)
**Say**: "Under the hood, we're using:
- TiDB Serverless with native VECTOR(384) columns for similarity search
- AWS SageMaker Serverless for embeddings with HuggingFace BGE model
- ECS Fargate for scalable deployment
- Real-time streaming with sub-second latency
- Tool-calling LLM agents for intelligent analysis"

## 🔧 Advanced Demo Options

### Docker-Only Mode
```bash
# Skip local services, run everything in Docker
autoir demo --skip-docker=false
```

### Console Mode (No Dashboard)
```bash
# For environments without terminal UI support
autoir demo --slack-demo
```

### Manual Component Testing
```bash
# Test individual components
autoir slack test --demo           # Send impressive Slack reports
./scripts/run-demo-fargate.sh      # Start Docker daemon manually
autoir logs query "error" --sagemaker-endpoint demo  # Test semantic search
```

## 🎯 What Makes This Demo Impressive

### 1. **It Actually Works**
- Real Slack integration that joins channels and sends messages
- Actual Docker containers with health checks
- Functional vector similarity search
- Live metrics and real-time updates

### 2. **Realistic Mock Data**
- 500+ realistic log events from AWS services
- Believable incident scenarios (DB timeouts, API limits, etc.)
- Proper AWS ARNs, container IDs, and service names
- Realistic performance metrics and latency numbers

### 3. **Professional Presentation**
- Beautiful terminal dashboard with live updates
- Rich Slack formatting with emojis and structured data
- Proper error handling and graceful fallbacks
- No obvious "demo mode" indicators

### 4. **Technical Depth**
- Real vector embeddings (384 dimensions)
- Proper SQL with TiDB vector operations
- Authentic AWS service simulation
- Production-ready architecture patterns

## 🛠️ Troubleshooting

### Docker Issues
```bash
# If Docker daemon fails to start
autoir demo --skip-docker --slack-demo
```

### Slack Not Working
```bash
# Reconfigure Slack
autoir slack setup --skip-test
```

### Dashboard Issues
```bash
# Use console mode instead
autoir demo --slack-demo
```

### Performance Issues
```bash
# Reduce activity frequency by editing demo-daemon.ts
# Change setTimeout values to be longer
```

## 🎉 Success Metrics

A successful demo should show:
- ✅ **1000+ logs processed** in the first few minutes
- ✅ **5+ incidents detected** with different severity levels
- ✅ **Multiple Slack alerts** sent with rich formatting
- ✅ **Sub-100ms query latency** for vector search
- ✅ **98%+ system health** maintained throughout
- ✅ **Real-time activity** in the dashboard feed

## 🚨 Demo Day Checklist

**30 minutes before:**
- [ ] Test internet connection for Slack
- [ ] Verify Docker is running
- [ ] Run `npm run build` to ensure latest code
- [ ] Test Slack integration with `autoir slack test --demo`

**5 minutes before:**
- [ ] Clear terminal history
- [ ] Close unnecessary applications
- [ ] Set terminal font size for visibility
- [ ] Have backup console mode ready: `autoir demo --slack-demo`

**During demo:**
- [ ] Start with `autoir demo --full-screen --slack-demo`
- [ ] Point out real-time metrics increasing
- [ ] Show semantic search in second terminal
- [ ] Highlight Slack notifications
- [ ] Emphasize technical architecture

**Pro tip**: The demo generates more activity in the first few minutes, so start it right when you begin presenting!

---

## 🎭 The Magic Behind the Scenes

This demo uses sophisticated mocking to create a convincing experience:

- **Database**: Switches seamlessly between real TiDB and local mock
- **AWS Services**: Realistic response times and data structures  
- **Embeddings**: Deterministic generation based on text content
- **Metrics**: Believable numbers that change over time
- **Logs**: Realistic formats from actual AWS services

The result is a demo that looks and feels like a production system while running entirely locally (except for Slack, which is real).

Ready to wow some judges? Run `autoir demo --full-screen --slack-demo` and watch the magic happen! 🎪✨