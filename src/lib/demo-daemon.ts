#!/usr/bin/env node

import {getDatabase} from './db-factory.js'
import {getMockSageMaker, getMockCloudWatchLogs} from './mock-aws.js'
import {SlackClient} from './slack.js'
import chalk from 'chalk'

class DemoDaemon {
  private isRunning = false
  private db: any
  private sagemaker: any
  private cloudwatch: any
  private slack?: SlackClient
  private stats = {
    logsProcessed: 0,
    incidentsCreated: 0,
    alertsSent: 0,
    uptime: Date.now()
  }

  async initialize(): Promise<void> {
    console.log(chalk.blue.bold('🤖 AutoIR Demo Daemon Starting...'))
    console.log(chalk.gray('Simulating AWS Fargate deployment with real-time log processing'))
    console.log()

    // Initialize database (will use mock)
    this.db = await getDatabase()
    console.log(chalk.green('✅ Database connection established'))

    // Initialize mock AWS services
    this.sagemaker = await getMockSageMaker('autoir-embed-ep-srv')
    this.cloudwatch = await getMockCloudWatchLogs()
    console.log(chalk.green('✅ AWS services initialized'))

    // Try to initialize Slack (optional)
    try {
      this.slack = new SlackClient()
      await this.slack.initialize()
      console.log(chalk.green('✅ Slack integration ready'))
    } catch (error) {
      console.log(chalk.yellow('⚠️ Slack not configured (optional)'))
    }

    console.log()
    console.log(chalk.cyan('📊 Demo Daemon Status:'))
    console.log(`  • Container ID: ${this.generateContainerId()}`)
    console.log(`  • Fargate Task: arn:aws:ecs:us-east-1:123456789012:task/autoir/${this.generateTaskId()}`)
    console.log(`  • Health Status: HEALTHY`)
    console.log(`  • CPU/Memory: 512 CPU units, 1024 MB`)
    console.log()
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    this.isRunning = true
    console.log(chalk.green.bold('🚀 Demo Daemon Started'))
    console.log(chalk.gray('Processing logs and generating incidents in real-time...'))
    console.log()

    // Start the main processing loop
    this.processLogs()
    this.generateIncidents()
    this.sendPeriodicReports()
    this.logStats()

    // Keep the process running
    process.on('SIGTERM', () => this.stop())
    process.on('SIGINT', () => this.stop())
  }

  private async processLogs(): Promise<void> {
    if (!this.isRunning) return

    try {
      // Simulate processing logs from CloudWatch
      const logGroups = [
        '/aws/lambda/user-api',
        '/aws/lambda/payment-service',
        '/aws/lambda/order-processor',
        '/aws/ecs/web-frontend',
        '/aws/apigateway/prod'
      ]

      const logGroup = logGroups[Math.floor(Math.random() * logGroups.length)]
      const events = await this.cloudwatch.getLogEvents(logGroup, Date.now() - 60000, 5)

      for (const event of events) {
        // Generate embedding for the log message
        const embedding = await this.sagemaker.invokeEndpoint(event.message)
        
        // Store in database
        await this.db.insertLogEvent({
          log_group: logGroup,
          log_stream: event.logStreamName,
          ts_ms: event.timestamp,
          message: event.message,
          embedding
        })

        this.stats.logsProcessed++
      }

      if (events.length > 0) {
        console.log(chalk.blue(`📝 Processed ${events.length} log events from ${logGroup}`))
      }

    } catch (error) {
      console.error(chalk.red('Error processing logs:'), error)
    }

    // Schedule next processing cycle
    setTimeout(() => this.processLogs(), 5000 + Math.random() * 5000) // 5-10 seconds
  }

  private async generateIncidents(): Promise<void> {
    if (!this.isRunning) return

    try {
      // Randomly generate incidents based on log patterns
      if (Math.random() < 0.3) { // 30% chance every cycle
        const incidents = [
          {
            severity: 'critical' as const,
            title: 'Database Connection Pool Exhaustion',
            summary: 'Multiple microservices experiencing connection timeouts to primary database. Connection pool utilization at 98%.',
            affected_group: '/aws/rds/aurora-cluster'
          },
          {
            severity: 'high' as const,
            title: 'API Gateway Rate Limiting Activated',
            summary: 'Unusual traffic spike detected. Rate limiting triggered for multiple client IPs.',
            affected_group: '/aws/apigateway/prod'
          },
          {
            severity: 'medium' as const,
            title: 'Lambda Cold Start Spike',
            summary: 'Increased cold start latency detected across payment processing functions.',
            affected_group: '/aws/lambda/payment-service'
          },
          {
            severity: 'high' as const,
            title: 'Memory Utilization Alert',
            summary: 'Container memory usage exceeded 90% threshold across multiple ECS tasks.',
            affected_group: '/aws/ecs/web-frontend'
          }
        ]

        const incident = incidents[Math.floor(Math.random() * incidents.length)]
        const now = Date.now()
        
        await this.db.insertIncident({
          created_ms: now,
          updated_ms: now,
          status: 'open',
          ...incident,
          first_ts_ms: now - 300000, // 5 minutes ago
          last_ts_ms: now,
          event_count: Math.floor(Math.random() * 50) + 10,
          dedupe_key: `${incident.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`
        })

        this.stats.incidentsCreated++
        console.log(chalk.red(`🚨 NEW INCIDENT: ${incident.title} (${incident.severity.toUpperCase()})`))

        // Send to Slack if available
        if (this.slack && Math.random() < 0.7) { // 70% chance
          try {
            await this.slack.sendIncidentReport({
              channel: this.slack.getDefaultChannel(),
              incident: {
                id: `INC-${Date.now()}`,
                ...incident,
                affectedServices: [incident.affected_group.split('/').pop() || 'unknown'],
                metrics: {
                  'Error Rate': `${Math.floor(Math.random() * 40 + 10)}%`,
                  'Response Time': `${(Math.random() * 5 + 1).toFixed(1)}s`,
                  'Affected Requests': `${Math.floor(Math.random() * 10000 + 1000).toLocaleString()}`
                }
              }
            })
            this.stats.alertsSent++
            console.log(chalk.green('  → Alert sent to Slack'))
          } catch (error) {
            console.log(chalk.yellow('  → Slack alert failed'))
          }
        }
      }

    } catch (error) {
      console.error(chalk.red('Error generating incidents:'), error)
    }

    // Schedule next incident generation
    setTimeout(() => this.generateIncidents(), 15000 + Math.random() * 30000) // 15-45 seconds
  }

  private async sendPeriodicReports(): Promise<void> {
    if (!this.isRunning) return

    try {
      if (this.slack && Math.random() < 0.4) { // 40% chance
        const reportType = Math.random()
        
        if (reportType < 0.5) {
          // Send metrics update
          const stats = this.db.getStats()
          await this.slack.sendMetricsUpdate(this.slack.getDefaultChannel(), {
            totalIncidents: stats.totalIncidents,
            resolvedIncidents: stats.resolvedIncidents,
            avgResolutionTime: stats.avgResolutionTime,
            systemHealth: stats.systemHealth,
            topIssues: [
              {name: 'Database Timeouts', count: Math.floor(Math.random() * 20 + 5)},
              {name: 'API Rate Limits', count: Math.floor(Math.random() * 15 + 3)},
              {name: 'Memory Alerts', count: Math.floor(Math.random() * 10 + 2)}
            ]
          })
          console.log(chalk.cyan('📊 Metrics report sent to Slack'))
        } else {
          // Send AI analysis update
          await this.slack.sendAIAnalysisUpdate(this.slack.getDefaultChannel(), {
            logVolume: `${(Math.random() * 50 + 20).toFixed(1)}K events/min`,
            anomaliesDetected: Math.floor(Math.random() * 15 + 5),
            predictionAccuracy: `${(Math.random() * 10 + 85).toFixed(1)}%`,
            modelPerformance: `${(Math.random() * 20 + 75).toFixed(1)}% efficiency`,
            insights: [
              'Database connection patterns show 15% increase in timeout errors',
              'Payment service latency correlates with memory utilization spikes',
              'API gateway rate limiting preventing 2.3K potentially harmful requests',
              'Auto-scaling triggered 4 times in the last hour due to traffic patterns'
            ]
          })
          console.log(chalk.magenta('🧠 AI analysis report sent to Slack'))
        }
      }

    } catch (error) {
      console.error(chalk.red('Error sending reports:'), error)
    }

    // Schedule next report
    setTimeout(() => this.sendPeriodicReports(), 60000 + Math.random() * 120000) // 1-3 minutes
  }

  private logStats(): void {
    if (!this.isRunning) return

    const uptime = Math.floor((Date.now() - this.stats.uptime) / 1000)
    const hours = Math.floor(uptime / 3600)
    const minutes = Math.floor((uptime % 3600) / 60)
    const seconds = uptime % 60

    console.log()
    console.log(chalk.gray('═'.repeat(60)))
    console.log(chalk.blue.bold('📊 AutoIR Daemon Statistics'))
    console.log(chalk.gray(`   Uptime: ${hours}h ${minutes}m ${seconds}s`))
    console.log(chalk.gray(`   Logs Processed: ${this.stats.logsProcessed.toLocaleString()}`))
    console.log(chalk.gray(`   Incidents Created: ${this.stats.incidentsCreated}`))
    console.log(chalk.gray(`   Alerts Sent: ${this.stats.alertsSent}`))
    console.log(chalk.gray(`   Memory Usage: ${Math.floor(process.memoryUsage().heapUsed / 1024 / 1024)}MB`))
    console.log(chalk.gray('═'.repeat(60)))
    console.log()

    // Schedule next stats log
    setTimeout(() => this.logStats(), 30000) // Every 30 seconds
  }

  private generateContainerId(): string {
    return Math.random().toString(36).slice(2, 14)
  }

  private generateTaskId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  private stop(): void {
    if (!this.isRunning) return

    console.log()
    console.log(chalk.yellow.bold('🛑 Demo Daemon Stopping...'))
    this.isRunning = false
    
    setTimeout(() => {
      console.log(chalk.green('✅ Demo Daemon Stopped'))
      process.exit(0)
    }, 1000)
  }
}

// Start the daemon
const daemon = new DemoDaemon()
daemon.initialize().then(() => daemon.start()).catch(error => {
  console.error(chalk.red.bold('❌ Failed to start daemon:'), error)
  process.exit(1)
})