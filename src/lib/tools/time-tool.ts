import {BaseTool} from './base-tool.js'

export class TimeTool extends BaseTool {
  readonly name = 'get_current_time'
  readonly description = 'Get the current date and time'
  readonly parameters = {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'Timezone to get time in (e.g., UTC, America/New_York)',
        default: 'UTC'
      }
    },
    required: []
  }

  async execute(args: Record<string, any>): Promise<string> {
    this.validateArguments(args)
    const timezone = args.timezone || 'UTC'
    
    try {
      return new Date().toLocaleString('en-US', {timeZone: timezone})
    } catch (error: any) {
      throw new Error(`Invalid timezone: ${timezone}`)
    }
  }
}
