import {Command, Flags} from '@oclif/core'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as readline from 'node:readline'
import {ToolManager, Tool, ToolCall, ToolResult} from '../../lib/tools/index.js'
import {LlmClient, LlmMessage} from '../../lib/llm/client.js'
import inquirer from 'inquirer'
import {SYSTEM_PROMPT_TEMPLATE} from '../../prompts/system.js'

const execFileAsync = promisify(execFile)

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_results?: ToolResult[]
}

interface Conversation {
  id: string
  name: string
  messages: Message[]
  endpoint: string
  createdAt: string
  updatedAt: string
}

export default class LlmChat extends Command {
  static description = 'Chat with an LLM (AWS Kimi K2 or OpenAI) with conversation history, streaming, and function calling'

  static examples = [
    '<%= config.bin %> <%= command.id %> --endpoint my-kimi-k2',
    '<%= config.bin %> <%= command.id %> --endpoint my-kimi-k2 --message "Hello, how are you?"',
    '<%= config.bin %> <%= command.id %> --endpoint my-kimi-k2 --conversation my-chat --stream',
    '<%= config.bin %> <%= command.id %> --endpoint my-kimi-k2 --list-conversations',
  ]

  static flags = {
    endpoint: Flags.string({description: 'AWS/Kimi K2 endpoint name from saved config'}),
    message: Flags.string({description: 'Single message to send (for non-interactive mode)'}),
    conversation: Flags.string({description: 'Conversation ID to continue or create'}),
    'system-prompt': Flags.string({description: 'System prompt to use'}),
    temperature: Flags.integer({description: 'Temperature for generation (0-100)', default: 60}),
    'max-tokens': Flags.integer({description: 'Maximum tokens to generate', default: 500}),
    stream: Flags.boolean({description: 'Stream the response', default: false}),
    'list-conversations': Flags.boolean({description: 'List all conversations', default: false}),
    'delete-conversation': Flags.string({description: 'Delete a specific conversation'}),
    'clear-history': Flags.boolean({description: 'Clear conversation history', default: false}),
    tools: Flags.boolean({description: 'Enable function calling with built-in tools', default: false}),
    'tool-timeout': Flags.integer({description: 'Timeout for tool execution in seconds', default: 30}),
    json: Flags.boolean({description: 'Output in JSON format', default: false}),
    debug: Flags.boolean({description: 'Show debug information', default: false}),
  }

  private conversationsDir!: string
  private configPath!: string
  private toolManager: ToolManager = new ToolManager()
  private llm: LlmClient = new LlmClient(this.toolManager)
  

  async run(): Promise<void> {
    const {flags} = await this.parse(LlmChat)
    
    // Initialize directories
    this.conversationsDir = path.join(os.homedir(), '.autoir', 'conversations')
    this.configPath = path.join(os.homedir(), '.autoir', 'kimi-k2-endpoints.json')
    
    await fs.mkdir(this.conversationsDir, {recursive: true})

    // Ensure LLM provider configured
    let endpointConfig: any = null
    const endpointName = flags.endpoint
    await this.llm.ensureConfigured(endpointName)
    if (endpointName) {
      endpointConfig = await this.loadEndpointConfig(endpointName)
      if (!endpointConfig) this.error(`Endpoint '${endpointName}' not found. Use 'autoir aws kimi-k2-list' to see available endpoints.`)
    }

    // Handle special commands
    if (flags['list-conversations']) {
      await this.listConversations()
      return
    }

    if (flags['delete-conversation']) {
      await this.deleteConversation(flags['delete-conversation'])
      return
    }

    if (flags['clear-history']) {
      await this.clearHistory()
      return
    }

    // Load or create conversation
    let conversation: Conversation
    if (flags.conversation) {
      conversation = await this.loadConversation(flags.conversation) || 
                    await this.createConversation(flags.conversation, endpointConfig?.endpoint || 'llm')
    } else {
      conversation = await this.createConversation(`chat-${Date.now()}`, endpointConfig?.endpoint || 'llm')
    }

    // Add system message if conversation is new
    if (conversation.messages.length === 0) {
      const systemPrompt = await this.resolveSystemPrompt(flags['system-prompt'])
      conversation.messages.push({
        role: 'system',
        content: systemPrompt
      })
    }

    // Handle single message mode
    if (flags.message) {
      await this.sendMessage(conversation, flags.message, {
        temperature: flags.temperature / 100,
        maxTokens: flags['max-tokens'],
        stream: flags.stream,
        tools: flags.tools ? this.toolManager.getAllTools() : undefined,
        toolTimeout: flags['tool-timeout'],
        json: flags.json,
        debug: flags.debug
      })
      return
    }

    // Interactive mode
    await this.interactiveChat(conversation, {
      temperature: flags.temperature / 100,
      maxTokens: flags['max-tokens'],
      stream: flags.stream,
              tools: flags.tools ? this.toolManager.getAllTools() : undefined,
      toolTimeout: flags['tool-timeout'],
      json: flags.json,
      debug: flags.debug
    })
  }

  private async resolveSystemPrompt(flagPrompt?: string): Promise<string> {
    if (flagPrompt) return flagPrompt
    return this.interpolatePrompt(SYSTEM_PROMPT_TEMPLATE)
  }

  private interpolatePrompt(template: string): string {
    const today = new Date().toISOString().slice(0, 10)
    return template
      .replaceAll('{{TODAY}}', today)
  }

  private async loadEndpointConfig(endpointName: string): Promise<any> {
    try {
      const configData = await fs.readFile(this.configPath, 'utf-8')
      const config = JSON.parse(configData)
      return config[endpointName]
    } catch (e) {
      return null
    }
  }

  private async listConversations(): Promise<void> {
    try {
      const files = await fs.readdir(this.conversationsDir)
      const conversations = files.filter(f => f.endsWith('.json'))
      
      if (conversations.length === 0) {
        this.log(chalk.yellow('No conversations found.'))
        return
      }

      this.log(chalk.blue('Conversations:'))
      for (const file of conversations) {
        const conversationPath = path.join(this.conversationsDir, file)
        const data = await fs.readFile(conversationPath, 'utf-8')
        const conversation: Conversation = JSON.parse(data)
        
        const messageCount = conversation.messages.length - 1 // Exclude system message
        const lastMessage = conversation.messages[conversation.messages.length - 1]
        const preview = lastMessage?.content?.slice(0, 50) + (lastMessage?.content?.length > 50 ? '...' : '')
        
        this.log(chalk.green(`${conversation.name}:`))
        this.log(`  Messages: ${messageCount}`)
        this.log(`  Last: ${preview}`)
        this.log(`  Updated: ${new Date(conversation.updatedAt).toLocaleString()}`)
        this.log('')
      }
    } catch (e) {
      this.error('Failed to list conversations')
    }
  }

  private async deleteConversation(conversationId: string): Promise<void> {
    const conversationPath = path.join(this.conversationsDir, `${conversationId}.json`)
    try {
      await fs.unlink(conversationPath)
      this.log(chalk.green(`Deleted conversation: ${conversationId}`))
    } catch (e) {
      this.error(`Conversation '${conversationId}' not found`)
    }
  }

  private async clearHistory(): Promise<void> {
    try {
      const files = await fs.readdir(this.conversationsDir)
      const conversations = files.filter(f => f.endsWith('.json'))
      
      for (const file of conversations) {
        await fs.unlink(path.join(this.conversationsDir, file))
      }
      
      this.log(chalk.green(`Cleared ${conversations.length} conversations`))
    } catch (e) {
      this.error('Failed to clear history')
    }
  }

  private async loadConversation(conversationId: string): Promise<Conversation | null> {
    const conversationPath = path.join(this.conversationsDir, `${conversationId}.json`)
    try {
      const data = await fs.readFile(conversationPath, 'utf-8')
      return JSON.parse(data)
    } catch (e) {
      return null
    }
  }

  private async createConversation(name: string, endpoint: string): Promise<Conversation> {
    const conversation: Conversation = {
      id: name,
      name,
      messages: [],
      endpoint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    await this.saveConversation(conversation)
    return conversation
  }

  private async saveConversation(conversation: Conversation): Promise<void> {
    conversation.updatedAt = new Date().toISOString()
    const conversationPath = path.join(this.conversationsDir, `${conversation.id}.json`)
    await fs.writeFile(conversationPath, JSON.stringify(conversation, null, 2))
  }

  private async interactiveChat(conversation: Conversation, options: any): Promise<void> {
    const providerLabel = this.llm.getProviderLabel()
    this.log(chalk.blue(`Chatting with ${providerLabel} (${conversation.name})`))
    this.log(chalk.gray('Type your message or use commands:'))
    this.log(chalk.gray('  /help - Show commands'))
    this.log(chalk.gray('  /save - Save conversation'))
    this.log(chalk.gray('  /clear - Clear conversation'))
    this.log(chalk.gray('  /exit - Exit chat'))
    this.log('')

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    const askQuestion = (): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(chalk.cyan('You: '), resolve)
      })
    }

    try {
      while (true) {
        const input = await askQuestion()
        
        if (input.trim() === '') continue
        
        if (input.startsWith('/')) {
          await this.handleCommand(input, conversation, rl)
          continue
        }

        await this.sendMessage(conversation, input, options)
        this.log('')
      }
    } finally {
      rl.close()
    }
  }

  private async handleCommand(command: string, conversation: Conversation, rl: readline.Interface): Promise<void> {
    const [cmd, ...args] = command.split(' ')
    
    switch (cmd) {
      case '/help':
        this.log(chalk.blue('Available commands:'))
        this.log('  /help - Show this help')
        this.log('  /save - Save conversation')
        this.log('  /clear - Clear conversation history')
        this.log('  /exit - Exit chat')
        this.log('  /tools - Show available tools')
        break
        
      case '/save':
        await this.saveConversation(conversation)
        this.log(chalk.green('Conversation saved'))
        break
        
      case '/clear':
        conversation.messages = [conversation.messages[0]] // Keep system message
        await this.saveConversation(conversation)
        this.log(chalk.green('Conversation cleared'))
        break
        
      case '/exit':
        rl.close()
        process.exit(0)
        break
        
              case '/tools':
        this.log(chalk.blue('Available tools:'))
        this.toolManager.listTools()
        break
        
      default:
        this.log(chalk.yellow(`Unknown command: ${cmd}`))
    }
  }

  private async sendMessage(conversation: Conversation, message: string, options: any): Promise<void> {
    // Add user message
    conversation.messages.push({
      role: 'user',
      content: message
    })

    // Build and send
    const response = await this.llm.send(conversation.messages as unknown as LlmMessage[], options)
    
    // Handle tool calls if present
    if (response.tool_calls && response.tool_calls.length > 0) {
      await this.handleToolCalls(conversation, response, options)
    } else {
      // Add assistant response
      conversation.messages.push({
        role: 'assistant',
        content: response.content
      })
      
      if (!options.json) {
        this.log(chalk.green('Assistant: ') + response.content)
      }
    }

    await this.saveConversation(conversation)
  }

  private buildPrompt(messages: Message[], tools?: Tool[]): string {
    let prompt = ''
    
    for (const message of messages) {
      switch (message.role) {
        case 'system':
          prompt += `<|im_system|>system<|im_middle|>${message.content}<|im_end|>`
          break
        case 'user':
          prompt += `<|im_user|>user<|im_middle|>${message.content}<|im_end|>`
          break
        case 'assistant':
          prompt += `<|im_assistant|>assistant<|im_middle|>${message.content}<|im_end|>`
          break
        case 'tool':
          prompt += `<|im_tool|>tool<|im_middle|>${message.content}<|im_end|>`
          break
      }
    }
    
    // Add tools if provided
    if (tools && tools.length > 0) {
      const toolsPrompt = `\n\nAvailable tools:\n${tools.map(t => 
        `${t.name}: ${t.description}`
      ).join('\n')}\n\nYou can use tools by calling them with appropriate parameters.`
      
      // Insert tools prompt before the last user message
      const lastUserIndex = messages.map(m => m.role).lastIndexOf('user')
      if (lastUserIndex !== -1) {
        const beforeUser = prompt.substring(0, prompt.lastIndexOf('<|im_user|>'))
        const afterUser = prompt.substring(prompt.lastIndexOf('<|im_user|>'))
        prompt = beforeUser + toolsPrompt + afterUser
      }
    }
    
    prompt += `<|im_assistant|>assistant<|im_middle|>`
    return prompt
  }

  private async callKimiK2(endpoint: string, prompt: string, options: any): Promise<any> {
    const payload = {
      prompt,
      temperature: options.temperature,
      min_p: 0.01,
      n_predict: options.maxTokens,
      stream: options.stream
    }

    if (options.json) {
      this.log(JSON.stringify(payload, null, 2))
    }

    try {
      const {stdout} = await execFileAsync('curl', [
        '-s', '-f',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(payload),
        `${endpoint}/completion`
      ])

      const response = JSON.parse(stdout)
      
      if (options.json) {
        this.log(JSON.stringify(response, null, 2))
      }

      return {
        content: response.content || '',
        tool_calls: response.tool_calls || []
      }
    } catch (error: any) {
      const stderr = error?.stderr?.toString?.() || error?.message || String(error)
      this.error(`Failed to call Kimi K2: ${stderr}`)
    }
  }

  private async handleToolCalls(conversation: Conversation, response: any, options: any): Promise<void> {
    // Add assistant message with tool calls
    conversation.messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls
    })

    // Execute tool calls
    const toolResults: ToolResult[] = []
    
    for (const toolCall of response.tool_calls) {
      const result = await this.executeTool(toolCall, options.toolTimeout)
      toolResults.push({
        call_id: toolCall.id,
        result
      })
      
      // Add tool result to conversation
      conversation.messages.push({
        role: 'tool',
        content: result,
        tool_results: [{
          call_id: toolCall.id,
          result
        }]
      })
    }

    // Get final response from assistant
    const finalResponse = await this.llm.send(conversation.messages as unknown as LlmMessage[], options)
    
    conversation.messages.push({
      role: 'assistant',
      content: finalResponse.content
    })

    if (!options.json) {
      this.log(chalk.green('Assistant: ') + finalResponse.content)
    }
  }

  private async executeTool(toolCall: any, timeout: number): Promise<string> {
    try { return await this.toolManager.executeTool(toolCall) } catch (e: any) { return `Error: ${e?.message || String(e)}` }
  }
}
