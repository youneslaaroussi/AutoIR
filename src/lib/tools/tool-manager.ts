import {BaseTool, Tool, ToolCall} from './base-tool.js'
import {TimeTool} from './time-tool.js'
import {CalculatorTool} from './calculator-tool.js'
import {FileReadTool, FileWriteTool} from './file-tool.js'
import {WebSearchTool} from './web-search-tool.js'
import {TiDBQueryTool} from './tidb-tool.js'
import {AnalysisTool} from './analysis-tool.js'
import ora from 'ora'

export class ToolManager {
  private tools: Map<string, BaseTool> = new Map()

  constructor() {
    this.registerDefaultTools()
  }

  private registerDefaultTools(): void {
    this.registerTool(new TimeTool())
    this.registerTool(new CalculatorTool())
    this.registerTool(new FileReadTool())
    this.registerTool(new FileWriteTool())
    this.registerTool(new WebSearchTool())
    this.registerTool(new TiDBQueryTool())
    this.registerTool(new AnalysisTool())
  }

  registerTool(tool: BaseTool): void {
    this.tools.set(tool.name, tool)
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name)
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).map(tool => tool.getToolDefinition())
  }

  async executeTool(toolCall: ToolCall): Promise<string> {
    const tool = this.getTool(toolCall.name)
    if (!tool) {
      throw new Error(`Unknown tool: ${toolCall.name}`)
    }

    const sp = ora(`Executing ${toolCall.name}...`).start()
    
    try {
      const result = await tool.execute(toolCall.arguments)
      sp.succeed(`Executed ${toolCall.name}`)
      return result
    } catch (error: any) {
      sp.fail(`Failed to execute ${toolCall.name}`)
      throw error
    }
  }

  async executeTools(toolCalls: ToolCall[]): Promise<Map<string, string>> {
    const results = new Map<string, string>()
    
    for (const toolCall of toolCalls) {
      try {
        const result = await this.executeTool(toolCall)
        results.set(toolCall.id, result)
      } catch (error: any) {
        results.set(toolCall.id, `Error: ${error.message}`)
      }
    }
    
    return results
  }

  listTools(): void {
    console.log('Available tools:')
    for (const tool of this.tools.values()) {
      console.log(`  ${tool.name}: ${tool.description}`)
    }
  }
}
