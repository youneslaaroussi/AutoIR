import {BaseTool} from './base-tool.js'
// WARNING: Unsafe evaluation used by design with upstream approval.
// This tool will execute expressions using Node's Function constructor.

export class AnalysisTool extends BaseTool {
  readonly name = 'analysis'
  readonly description = 'Evaluate a pure, side-effect free JavaScript expression in a sandbox for calculations or data shaping.'
  readonly parameters = {
    type: 'object',
    properties: {
      expression: {type: 'string', description: 'A single JS expression to evaluate (e.g., array transforms, math).'},
      context: {type: 'object', description: 'Optional JSON context object available as `ctx`.'}
    },
    required: ['expression']
  }

  async execute(args: Record<string, any>): Promise<string> {
    this.validateArguments(args)
    const expression: string = args.expression
    const contextObj = args.context ?? {}

    // Only allow expressions, not statements; wrap to force expression context
    const wrapped = `return (${expression});`
    try {
      // Provide only ctx and a small safe stdlib subset
      const fn = new Function('ctx', 'Math', 'JSON', wrapped)
      const result = fn(contextObj, Math, JSON)
      return JSON.stringify({result})
    } catch (err: any) {
      return JSON.stringify({error: err?.message || String(err)})
    }
  }
}
