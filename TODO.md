# AutoIR TODO

## Infrastructure Improvements

- [ ] **Redis Queue for Log Processing**
  - Replace in-memory buffer with Redis queue for durability
  - Enable horizontal scaling (multiple tail processes)
  - Add retry logic for failed embeddings
  - Better monitoring of queue depth and processing rates

## SageMaker Optimizations

- [ ] **Upgrade Serverless Endpoint**
  - Increase memory from 2GB to 4GB+ 
  - Increase max concurrency from 5 to 20+
  - OR switch to dedicated instance for consistent performance

- [ ] **Implement Exponential Backoff**
  - Add retry logic with backoff for ThrottlingException
  - Handle rate limiting more gracefully

## Code Quality

- [ ] **Better Error Handling**
  - Structured logging instead of console.error
  - Metrics collection for embedding success/failure rates
  - Alert on high failure rates

- [ ] **Configuration Management**
  - Environment-based configs for different deployment stages
  - Validation of SageMaker endpoint health before starting

## Features

- [ ] **Multi-Group Support**
  - Tail multiple CloudWatch log groups simultaneously
  - Separate embedding queues per group

- [ ] **Query Improvements** 
  - Add filters by time range, log level, etc.
  - Better result ranking and relevance scoring
