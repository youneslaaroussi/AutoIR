import {promises as fs} from 'node:fs'
import path from 'node:path'
import os from 'node:os'

interface SlackConfig {
  botToken: string
  appToken: string
  signingSecret: string
  channels: string[]
  webhookUrl?: string
}

interface SlackMessage {
  channel: string
  text: string
  blocks?: any[]
}

interface IncidentData {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  summary: string
  affectedServices?: string[]
  metrics?: Record<string, string>
  timeline?: string[]
}

interface IncidentReport {
  channel: string
  incident: IncidentData
}

const SLACK_CONFIG_FILE = path.join(os.homedir(), '.autoir', 'slack-config.json')

export class SlackClient {
  private config?: SlackConfig

  async initialize(): Promise<void> {
    try {
      const configData = await fs.readFile(SLACK_CONFIG_FILE, 'utf8')
      this.config = JSON.parse(configData)
      
      if (!this.config?.botToken) {
        throw new Error('Slack bot token not configured. Run: autoir slack setup')
      }
    } catch (error) {
      throw new Error('Slack not configured. Run: autoir slack setup')
    }
  }

  getDefaultChannel(): string {
    return this.config?.channels[0] || 'general'
  }

  async sendMessage(message: SlackMessage): Promise<void> {
    if (!this.config) {
      throw new Error('Slack client not initialized')
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })

    const data = await response.json() as any
    
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`)
    }
  }

  async sendIncidentReport(report: IncidentReport): Promise<void> {
    const {incident} = report
    
    const severityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '🔶',
      low: '🔵',
      info: 'ℹ️'
    }

    const severityColor = {
      critical: '#FF0000',
      high: '#FF8C00',
      medium: '#FFD700',
      low: '#32CD32',
      info: '#1E90FF'
    }

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji[incident.severity]} ${incident.title.toUpperCase()}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Incident ID:* ${incident.id}\n*Severity:* ${incident.severity.toUpperCase()}\n*Summary:* ${incident.summary}`
        }
      }
    ]

    if (incident.affectedServices && incident.affectedServices.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🛠️ Affected Services:*\n${incident.affectedServices.map(s => `• ${s}`).join('\n')}`
        }
      })
    }

    if (incident.metrics) {
      const metricsText = Object.entries(incident.metrics)
        .map(([key, value]) => `*${key}:* ${value}`)
        .join('\n')
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📊 Key Metrics:*\n${metricsText}`
        }
      })
    }

    if (incident.timeline && incident.timeline.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*⏱️ Timeline:*\n${incident.timeline.map(t => `• ${t}`).join('\n')}`
        }
      })
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🤖 AutoIR Alert • ${new Date().toISOString()} • Automated Detection & Analysis`
        }
      ]
    } as any)

    await this.sendMessage({
      channel: report.channel,
      text: `${severityEmoji[incident.severity]} ${incident.title}`,
      blocks
    })
  }

  async sendMetricsUpdate(channel: string, metrics: {
    totalIncidents: number
    resolvedIncidents: number
    avgResolutionTime: string
    systemHealth: string
    topIssues: Array<{name: string, count: number}>
  }): Promise<void> {
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '📊 AutoIR System Health Report'
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Total Incidents:*\n${metrics.totalIncidents}`
          },
          {
            type: 'mrkdwn',
            text: `*Resolved:*\n${metrics.resolvedIncidents}`
          },
          {
            type: 'mrkdwn',
            text: `*Avg Resolution:*\n${metrics.avgResolutionTime}`
          },
          {
            type: 'mrkdwn',
            text: `*System Health:*\n${metrics.systemHealth}`
          }
        ]
      }
    ]

    if (metrics.topIssues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🔥 Top Issues:*\n${metrics.topIssues.map(issue => `• ${issue.name}: ${issue.count} occurrences`).join('\n')}`
        }
      })
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🤖 AutoIR Metrics • Generated at ${new Date().toISOString()}`
        }
      ]
    } as any)

    await this.sendMessage({
      channel,
      text: '📊 AutoIR System Health Report',
      blocks
    })
  }

  async sendAIAnalysisUpdate(channel: string, analysis: {
    logVolume: string
    anomaliesDetected: number
    predictionAccuracy: string
    modelPerformance: string
    insights: string[]
  }): Promise<void> {
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🧠 AI Analysis Report'
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Log Volume Processed:*\n${analysis.logVolume}`
          },
          {
            type: 'mrkdwn',
            text: `*Anomalies Detected:*\n${analysis.anomaliesDetected}`
          },
          {
            type: 'mrkdwn',
            text: `*Prediction Accuracy:*\n${analysis.predictionAccuracy}`
          },
          {
            type: 'mrkdwn',
            text: `*Model Performance:*\n${analysis.modelPerformance}`
          }
        ]
      }
    ]

    if (analysis.insights.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🔍 Key Insights:*\n${analysis.insights.map(insight => `• ${insight}`).join('\n')}`
        }
      })
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🤖 AutoIR AI Engine • Analysis completed at ${new Date().toISOString()}`
        }
      ]
    } as any)

    await this.sendMessage({
      channel,
      text: '🧠 AI Analysis Report',
      blocks
    })
  }
}