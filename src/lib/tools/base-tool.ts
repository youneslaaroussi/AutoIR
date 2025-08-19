export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

export interface ToolResult {
  call_id: string
  result: string
}

export interface Tool {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, any>
    required: string[]
  }
}

export abstract class BaseTool {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly parameters: {
    type: string
    properties: Record<string, any>
    required: string[]
  }

  abstract execute(args: Record<string, any>): Promise<string>

  getToolDefinition(): Tool {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    }
  }

  validateArguments(args: Record<string, any>): void {
    for (const required of this.parameters.required) {
      if (!(required in args)) {
        throw new Error(`Missing required argument: ${required}`)
      }
    }
  }
}
