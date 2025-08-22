import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MOCK_AWS_DIR = path.join(os.homedir(), '.autoir', 'mock-aws')

// Mock SageMaker Embeddings
export class MockSageMaker {
  private endpointName: string
  private isInitialized = false

  constructor(endpointName: string) {
    this.endpointName = endpointName
  }

  async initialize(): Promise<void> {
    await fs.mkdir(MOCK_AWS_DIR, {recursive: true})
    this.isInitialized = true
  }

  async invokeEndpoint(inputText: string): Promise<number[]> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 200))

    // Generate a realistic-looking embedding (384 dimensions for BGE-small)
    const embedding = this.generateEmbedding(inputText)
    
    return embedding
  }

  private generateEmbedding(text: string): number[] {
    // Create a deterministic but realistic embedding based on text content
    const hash = this.simpleHash(text)
    const embedding = []
    
    for (let i = 0; i < 384; i++) {
      // Use hash and position to create deterministic values
      const seed = hash + i * 12345
      const value = Math.sin(seed) * 0.8 // Keep values reasonable
      embedding.push(value)
    }
    
    // Normalize to unit vector (like real embeddings)
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
    return embedding.map(val => val / magnitude)
  }

  private simpleHash(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return hash
  }

  getEndpointStatus() {
    return {
      EndpointName: this.endpointName,
      EndpointStatus: 'InService',
      CreationTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Created 24h ago
      LastModifiedTime: new Date(),
      ProductionVariants: [
        {
          VariantName: 'AllTraffic',
          CurrentWeight: 1.0,
          CurrentInstanceCount: 1,
          CurrentServerlessConfig: {
            MaxConcurrency: 20,
            MemorySizeInMB: 3008
          }
        }
      ]
    }
  }
}

// Mock CloudWatch Logs
export class MockCloudWatchLogs {
  private logGroups: Map<string, any[]> = new Map()

  async initialize(): Promise<void> {
    await fs.mkdir(MOCK_AWS_DIR, {recursive: true})
    
    // Generate sample log data for demo
    await this.generateSampleLogs()
  }

  private async generateSampleLogs(): Promise<void> {
    const logGroups = [
      '/aws/lambda/user-api',
      '/aws/lambda/payment-service', 
      '/aws/lambda/order-processor',
      '/aws/ecs/web-frontend',
      '/aws/apigateway/prod'
    ]

    const sampleMessages = [
      '[INFO] 2024-01-15T14:23:15.123Z Request processed successfully in 245ms',
      '[WARN] 2024-01-15T14:23:16.456Z Database connection pool utilization at 85%',
      '[ERROR] 2024-01-15T14:23:17.789Z Connection timeout after 30 seconds',
      '[INFO] 2024-01-15T14:23:18.012Z User authentication successful for user_id=12345',
      '[ERROR] 2024-01-15T14:23:19.345Z Payment processing failed - invalid card number',
      '[INFO] 2024-01-15T14:23:20.678Z Order created successfully, order_id=ORD-789',
      '[WARN] 2024-01-15T14:23:21.901Z High memory usage detected: 92% of 1GB',
      '[ERROR] 2024-01-15T14:23:22.234Z Database connection pool exhausted',
      '[INFO] 2024-01-15T14:23:23.567Z Cache hit ratio: 94.2%',
      '[ERROR] 2024-01-15T14:23:24.890Z API rate limit exceeded for client_id=abc123'
    ]

    for (const logGroup of logGroups) {
      const events = []
      const now = Date.now()
      
      for (let i = 0; i < 100; i++) {
        const timestamp = now - (Math.random() * 60 * 60 * 1000) // Last hour
        const message = sampleMessages[Math.floor(Math.random() * sampleMessages.length)]
        
        events.push({
          timestamp,
          message,
          logStreamName: `prod-instance-${Math.floor(Math.random() * 3) + 1}`,
          eventId: this.generateId()
        })
      }
      
      events.sort((a, b) => b.timestamp - a.timestamp) // Most recent first
      this.logGroups.set(logGroup, events)
    }
  }

  async getLogEvents(logGroupName: string, startTime?: number, limit = 100): Promise<any[]> {
    const events = this.logGroups.get(logGroupName) || []
    
    let filteredEvents = events
    if (startTime) {
      filteredEvents = events.filter(e => e.timestamp >= startTime)
    }
    
    return filteredEvents.slice(0, limit)
  }

  async describeLogGroups(): Promise<any[]> {
    return Array.from(this.logGroups.keys()).map(name => ({
      logGroupName: name,
      creationTime: Date.now() - 7 * 24 * 60 * 60 * 1000, // Created 7 days ago
      metricFilterCount: 0,
      arn: `arn:aws:logs:us-east-1:123456789012:log-group:${name}:*`,
      storedBytes: Math.floor(Math.random() * 1000000000), // Random size
      retentionInDays: 30
    }))
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

// Mock ECS Fargate
export class MockECS {
  private clusters: Map<string, any> = new Map()
  private services: Map<string, any> = new Map()
  private tasks: Map<string, any> = new Map()

  async initialize(): Promise<void> {
    await fs.mkdir(MOCK_AWS_DIR, {recursive: true})
    
    // Create default cluster and service
    this.createCluster('autoir')
    this.createService('autoir', 'autoir')
  }

  private createCluster(clusterName: string): void {
    this.clusters.set(clusterName, {
      clusterName,
      clusterArn: `arn:aws:ecs:us-east-1:123456789012:cluster/${clusterName}`,
      status: 'ACTIVE',
      runningTasksCount: 1,
      pendingTasksCount: 0,
      activeServicesCount: 1,
      statistics: [
        {name: 'runningTasksCount', value: '1'},
        {name: 'pendingTasksCount', value: '0'},
        {name: 'activeServicesCount', value: '1'}
      ],
      capacityProviders: ['FARGATE'],
      defaultCapacityProviderStrategy: [
        {capacityProvider: 'FARGATE', weight: 1}
      ]
    })
  }

  private createService(clusterName: string, serviceName: string): void {
    const taskArn = `arn:aws:ecs:us-east-1:123456789012:task/${clusterName}/${this.generateId()}`
    
    this.services.set(`${clusterName}:${serviceName}`, {
      serviceName,
      clusterArn: `arn:aws:ecs:us-east-1:123456789012:cluster/${clusterName}`,
      serviceArn: `arn:aws:ecs:us-east-1:123456789012:service/${clusterName}/${serviceName}`,
      status: 'ACTIVE',
      runningCount: 1,
      pendingCount: 0,
      desiredCount: 1,
      taskDefinition: `arn:aws:ecs:us-east-1:123456789012:task-definition/${serviceName}:1`,
      launchType: 'FARGATE',
      platformVersion: 'LATEST',
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      deployments: [
        {
          id: this.generateId(),
          status: 'PRIMARY',
          taskDefinition: `arn:aws:ecs:us-east-1:123456789012:task-definition/${serviceName}:1`,
          desiredCount: 1,
          runningCount: 1,
          pendingCount: 0,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
          updatedAt: new Date()
        }
      ]
    })

    // Create associated task
    this.tasks.set(taskArn, {
      taskArn,
      clusterArn: `arn:aws:ecs:us-east-1:123456789012:cluster/${clusterName}`,
      taskDefinitionArn: `arn:aws:ecs:us-east-1:123456789012:task-definition/${serviceName}:1`,
      lastStatus: 'RUNNING',
      desiredStatus: 'RUNNING',
      healthStatus: 'HEALTHY',
      cpu: '512',
      memory: '1024',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      startedAt: new Date(Date.now() - 55 * 60 * 1000),
      connectivity: 'CONNECTED',
      connectivityAt: new Date(Date.now() - 55 * 60 * 1000),
      pullStartedAt: new Date(Date.now() - 58 * 60 * 1000),
      pullStoppedAt: new Date(Date.now() - 56 * 60 * 1000),
      containers: [
        {
          containerArn: `${taskArn}/autoir-daemon`,
          name: 'autoir-daemon',
          image: 'autoir:latest',
          lastStatus: 'RUNNING',
          networkBindings: [],
          networkInterfaces: [
            {
              attachmentId: 'eni-' + this.generateId(),
              privateIpv4Address: '10.0.1.42'
            }
          ],
          healthStatus: 'HEALTHY',
          cpu: '256',
          memory: '512'
        }
      ]
    })
  }

  async describeServices(clusterName: string, serviceName: string): Promise<any> {
    const service = this.services.get(`${clusterName}:${serviceName}`)
    if (!service) {
      throw new Error(`Service ${serviceName} not found in cluster ${clusterName}`)
    }
    return service
  }

  async listTasks(clusterName: string, serviceName?: string): Promise<any[]> {
    return Array.from(this.tasks.values()).filter(task => 
      task.clusterArn.includes(clusterName)
    )
  }

  async describeTasks(clusterName: string, taskArns: string[]): Promise<any[]> {
    return taskArns.map(arn => this.tasks.get(arn)).filter(Boolean)
  }

  async deployService(clusterName: string, serviceName: string, options: any = {}): Promise<any> {
    // Simulate deployment process
    const service = this.services.get(`${clusterName}:${serviceName}`)
    if (service) {
      // Update existing service
      service.deployments.unshift({
        id: this.generateId(),
        status: 'PRIMARY',
        taskDefinition: options.taskDefinition || service.taskDefinition,
        desiredCount: options.desiredCount || service.desiredCount,
        runningCount: options.desiredCount || service.desiredCount,
        pendingCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      
      // Mark old deployment as inactive
      if (service.deployments.length > 1) {
        service.deployments[1].status = 'ACTIVE'
      }
    } else {
      this.createService(clusterName, serviceName)
    }

    return this.services.get(`${clusterName}:${serviceName}`)
  }

  getMetrics() {
    return {
      runningTasks: this.tasks.size,
      healthyTasks: Array.from(this.tasks.values()).filter(t => t.healthStatus === 'HEALTHY').length,
      cpuUtilization: Math.random() * 30 + 20, // 20-50%
      memoryUtilization: Math.random() * 40 + 30, // 30-70%
      networkRxBytes: Math.floor(Math.random() * 1000000),
      networkTxBytes: Math.floor(Math.random() * 500000)
    }
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

// Mock SNS
export class MockSNS {
  private topics: Map<string, any> = new Map()
  private messages: any[] = []

  async initialize(): Promise<void> {
    await fs.mkdir(MOCK_AWS_DIR, {recursive: true})
  }

  async publish(topicArn: string, message: string, subject?: string): Promise<string> {
    const messageId = this.generateId()
    
    this.messages.push({
      messageId,
      topicArn,
      message,
      subject,
      timestamp: new Date(),
      delivered: true
    })

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 50))

    return messageId
  }

  async createTopic(name: string): Promise<string> {
    const topicArn = `arn:aws:sns:us-east-1:123456789012:${name}`
    
    this.topics.set(topicArn, {
      topicArn,
      displayName: name,
      subscriptionsConfirmed: 1,
      subscriptionsPending: 0,
      subscriptionsDeleted: 0,
      deliveryPolicy: '',
      effectiveDeliveryPolicy: '',
      policy: '',
      owner: '123456789012',
      createdTime: new Date()
    })

    return topicArn
  }

  getRecentMessages(limit = 10): any[] {
    return this.messages.slice(-limit).reverse()
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

// Global instances
let mockSageMaker: MockSageMaker | null = null
let mockCloudWatch: MockCloudWatchLogs | null = null
let mockECS: MockECS | null = null
let mockSNS: MockSNS | null = null

export async function getMockSageMaker(endpointName: string): Promise<MockSageMaker> {
  if (!mockSageMaker) {
    mockSageMaker = new MockSageMaker(endpointName)
    await mockSageMaker.initialize()
  }
  return mockSageMaker
}

export async function getMockCloudWatchLogs(): Promise<MockCloudWatchLogs> {
  if (!mockCloudWatch) {
    mockCloudWatch = new MockCloudWatchLogs()
    await mockCloudWatch.initialize()
  }
  return mockCloudWatch
}

export async function getMockECS(): Promise<MockECS> {
  if (!mockECS) {
    mockECS = new MockECS()
    await mockECS.initialize()
  }
  return mockECS
}

export async function getMockSNS(): Promise<MockSNS> {
  if (!mockSNS) {
    mockSNS = new MockSNS()
    await mockSNS.initialize()
  }
  return mockSNS
}