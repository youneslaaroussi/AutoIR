# AutoIR

Incident Reporting for AWS using AI Agents powered by TiDB and Kimi K2.

## Installation

```bash
npm install -g autoir
```

## Usage

AutoIR provides a comprehensive CLI for AWS incident reporting and monitoring using AI agents.

### Basic Commands

```bash
# Start the AutoIR daemon
autoir daemon

# Query logs
autoir logs query

# Search logs
autoir logs search

# View latest logs
autoir logs latest

# Tail logs in real-time
autoir logs tail

# Chat with AI assistant
autoir llm chat

# Configure LLM settings
autoir llm config
```

### AWS Commands

```bash
# Check AWS configuration
autoir aws check

# Manage Kimi K2 instances
autoir aws kimi-k2-list
autoir aws kimi-k2-setup
autoir aws kimi-k2-manage

# Setup SageMaker
autoir aws sagemaker-bootstrap

# Deploy to Fargate
autoir aws autoir-fargate

# Monitor log noise
autoir aws logs-noise
```

### TiDB Commands

```bash
# Configure TiDB connection
autoir tidb dsn

# Setup OAuth for TiDB
autoir tidb oauth
```

## Configuration

AutoIR requires proper AWS credentials and TiDB connection settings. Use the configuration commands to set up your environment:

1. Configure AWS credentials using `aws configure` or environment variables
2. Set up TiDB connection using `autoir tidb dsn`
3. Configure LLM settings using `autoir llm config`

## Features

- **AI-Powered Analysis**: Uses advanced AI agents for intelligent incident analysis
- **AWS Integration**: Deep integration with AWS services including CloudWatch, SNS, and SageMaker
- **Real-time Monitoring**: Live log tailing and monitoring capabilities
- **TiDB Backend**: Leverages TiDB for scalable data storage and querying
- **Interactive UI**: Terminal-based user interface with real-time updates
- **Flexible Deployment**: Support for local development and Fargate deployment

## Requirements

- Node.js >= 18.0.0
- AWS CLI configured with appropriate permissions
- TiDB instance (for data storage)
- Kimi K2 API access (for AI capabilities)

## Development

```bash
# Clone the repository
git clone https://github.com/youneslaaroussi/autoir.git
cd autoir

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## License

MIT

## Author

Younes Laaroussi

## Contributing

Issues and pull requests are welcome! Please visit the [GitHub repository](https://github.com/youneslaaroussi/autoir) to contribute.

## Support

For support, please open an issue on the [GitHub issues page](https://github.com/youneslaaroussi/autoir/issues).
