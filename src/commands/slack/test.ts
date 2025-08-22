import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import ora from 'ora'
import {SlackClient} from '../../lib/slack.js'

export default class SlackTest extends Command {
  static description = 'Test Slack integration and send sample incident reports'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --demo',
  ]

  static flags = {
    demo: Flags.boolean({description: 'Send impressive demo incident reports', default: false}),
    channel: Flags.string({description: 'Specific channel to test (overrides config)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SlackTest)

    this.log(chalk.blue.bold('🧪 Testing Slack Integration'))
    this.log()

    const slack = new SlackClient()
    
    try {
      await slack.initialize()
      
      if (flags.demo) {
        await this.sendDemoReports(slack, flags.channel)
      } else {
        await this.basicTest(slack, flags.channel)
      }
      
      this.log()
      this.log(chalk.green.bold('✅ Slack integration test completed successfully!'))
      
    } catch (error) {
      this.log()
      this.log(chalk.red.bold('❌ Slack integration test failed:'))
      this.log(chalk.red(error))
      process.exit(1)
    }
  }

  private async basicTest(slack: SlackClient, channel?: string): Promise<void> {
    const spinner = ora('Sending basic test message...').start()
    
    await slack.sendMessage({
      channel: channel || slack.getDefaultChannel(),
      text: '🧪 AutoIR Test Message',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*🧪 AutoIR Slack Integration Test*\n\nThis is a test message to verify the Slack integration is working correctly.'
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Test performed at ${new Date().toISOString()}`
            }
          ]
        }
      ]
    })
    
    spinner.succeed('Basic test message sent')
  }

  private async sendDemoReports(slack: SlackClient, channel?: string): Promise<void> {
    const targetChannel = channel || slack.getDefaultChannel()
    
    this.log(chalk.cyan('Sending impressive demo incident reports...'))
    this.log()

    // Critical Database Connection Issue
    let spinner = ora('Sending critical database incident...').start()
    await slack.sendIncidentReport({
      channel: targetChannel,
      incident: {
        id: 'INC-2024-001',
        severity: 'critical',
        title: 'Database Connection Pool Exhaustion Detected',
        summary: 'Multiple microservices experiencing connection timeouts to primary RDS instance. Connection pool exhausted with 95% utilization spike in the last 5 minutes.',
        affectedServices: ['user-api', 'payment-service', 'order-processor'],
        metrics: {
          errorRate: '45.2%',
          responseTime: '12.4s avg',
          affectedRequests: '15,847',
        },
        timeline: [
          '14:23:15 - First timeout errors detected',
          '14:24:32 - Connection pool utilization hits 90%',
          '14:25:18 - Multiple services reporting failures',
          '14:26:05 - AutoIR incident created automatically'
        ]
      }
    })
    spinner.succeed('Critical database incident sent')

    await new Promise(resolve => setTimeout(resolve, 2000))

    // Security Alert
    spinner = ora('Sending security incident...').start()
    await slack.sendIncidentReport({
      channel: targetChannel,
      incident: {
        id: 'SEC-2024-007',
        severity: 'high',
        title: 'Suspicious API Access Pattern Detected',
        summary: 'Anomalous API access patterns detected from 3 IP addresses. Rate limiting triggered, potential credential stuffing attack in progress.',
        affectedServices: ['auth-api', 'user-management'],
        metrics: {
          suspiciousRequests: '2,847',
          blockedIPs: '3',
          failedLogins: '1,234',
        },
        timeline: [
          '14:20:00 - Unusual traffic spike detected',
          '14:21:15 - Rate limiting activated',
          '14:22:30 - IP addresses blocked automatically',
          '14:23:45 - Security team notified'
        ]
      }
    })
    spinner.succeed('Security incident sent')

    await new Promise(resolve => setTimeout(resolve, 2000))

    // Performance Degradation
    spinner = ora('Sending performance incident...').start()
    await slack.sendIncidentReport({
      channel: targetChannel,
      incident: {
        id: 'PERF-2024-012',
        severity: 'medium',
        title: 'CDN Cache Miss Rate Spike - Performance Impact',
        summary: 'CDN cache miss rate increased from 5% to 78% causing significant performance degradation. Origin server load increased 4x.',
        affectedServices: ['web-frontend', 'api-gateway', 'media-service'],
        metrics: {
          cacheMissRate: '78%',
          originLoad: '400% increase',
          p95ResponseTime: '3.2s',
        },
        timeline: [
          '14:15:00 - Cache miss rate begins climbing',
          '14:17:30 - Performance alerts triggered',
          '14:19:15 - Origin server load spikes',
          '14:21:00 - AutoIR analysis completed'
        ]
      }
    })
    spinner.succeed('Performance incident sent')

    await new Promise(resolve => setTimeout(resolve, 2000))

    // Resolution Update
    spinner = ora('Sending incident resolution...').start()
    await slack.sendMessage({
      channel: targetChannel,
      text: '✅ Incident Resolution Update',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '✅ Incident Resolved: INC-2024-001'
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: '*Resolution Time:*\n3 minutes 42 seconds'
            },
            {
              type: 'mrkdwn',
              text: '*Root Cause:*\nConnection pool misconfiguration'
            },
            {
              type: 'mrkdwn',
              text: '*Action Taken:*\nIncreased pool size, deployed hotfix'
            },
            {
              type: 'mrkdwn',
              text: '*Services Restored:*\nAll services operational'
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*📊 Impact Summary:*\n• Duration: 3m 42s\n• Affected Users: ~1,200\n• Revenue Impact: $0 (prevented by quick resolution)\n• SLA Status: ✅ Within target'
          }
        }
      ]
    })
    spinner.succeed('Incident resolution sent')
  }
}