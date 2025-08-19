import {BaseTool} from './base-tool.js'

export class CalculatorTool extends BaseTool {
  readonly name = 'calculate'
  readonly description = 'Perform mathematical calculations'
  readonly parameters = {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Mathematical expression to evaluate'
      }
    },
    required: ['expression']
  }

  async execute(args: Record<string, any>): Promise<string> {
    this.validateArguments(args)
    const expression = args.expression
    
    try {
      // Sanitize expression to only allow safe mathematical operations
      const sanitizedExpression = this.sanitizeExpression(expression)
      const result = eval(sanitizedExpression)
      
      if (typeof result !== 'number' || !isFinite(result)) {
        throw new Error('Invalid mathematical result')
      }
      
      return result.toString()
    } catch (error: any) {
      throw new Error(`Invalid mathematical expression: ${expression}`)
    }
  }

  private sanitizeExpression(expression: string): string {
    // Only allow numbers, basic operators, parentheses, and decimal points
    const sanitized = expression.replace(/[^0-9+\-*/().,]/g, '')
    
    // Additional safety checks
    if (sanitized.length === 0) {
      throw new Error('Expression contains no valid mathematical characters')
    }
    
    // Prevent potential code injection by checking for suspicious patterns
    if (sanitized.includes('eval') || sanitized.includes('Function') || sanitized.includes('constructor')) {
      throw new Error('Expression contains forbidden patterns')
    }
    
    return sanitized
  }
}
