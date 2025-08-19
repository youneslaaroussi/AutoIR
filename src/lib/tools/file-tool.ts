import {BaseTool} from './base-tool.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export class FileReadTool extends BaseTool {
  readonly name = 'read_file'
  readonly description = 'Read contents of a file'
  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read'
      }
    },
    required: ['path']
  }

  async execute(args: Record<string, any>): Promise<string> {
    this.validateArguments(args)
    const filePath = args.path
    
    try {
      // Basic path validation
      if (!this.isValidPath(filePath)) {
        throw new Error('Invalid file path')
      }
      
      const content = await fs.readFile(filePath, 'utf-8')
      return content
    } catch (error: any) {
      throw new Error(`Error reading file: ${error.message}`)
    }
  }

  private isValidPath(filePath: string): boolean {
    // Basic validation - could be enhanced with more security checks
    return filePath.length > 0 && !filePath.includes('..') && !filePath.startsWith('/')
  }
}

export class FileWriteTool extends BaseTool {
  readonly name = 'write_file'
  readonly description = 'Write content to a file'
  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write'
      },
      content: {
        type: 'string',
        description: 'Content to write to the file'
      }
    },
    required: ['path', 'content']
  }

  async execute(args: Record<string, any>): Promise<string> {
    this.validateArguments(args)
    const filePath = args.path
    const content = args.content
    
    try {
      // Basic path validation
      if (!this.isValidPath(filePath)) {
        throw new Error('Invalid file path')
      }
      
      // Ensure directory exists
      const dir = path.dirname(filePath)
      await fs.mkdir(dir, {recursive: true})
      
      await fs.writeFile(filePath, content)
      return `Successfully wrote to ${filePath}`
    } catch (error: any) {
      throw new Error(`Error writing file: ${error.message}`)
    }
  }

  private isValidPath(filePath: string): boolean {
    // Basic validation - could be enhanced with more security checks
    return filePath.length > 0 && !filePath.includes('..') && !filePath.startsWith('/')
  }
}
