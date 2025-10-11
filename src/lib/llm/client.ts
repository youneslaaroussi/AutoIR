import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import inquirer from 'inquirer'
import {getLlmConfig, setLlmConfig} from '../config.js'
import {ToolManager, Tool, ToolCall, ToolResult} from '../tools/index.js'
import {SYSTEM_PROMPT_TEMPLATE} from '../../prompts/system.js'

const execFileAsync = promisify(execFile)

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool'

export interface LlmMessage {
  role: LlmRole
  content: string
  tool_calls?: ToolCall[]
  tool_results?: ToolResult[]
}

export interface LlmOptions {
  temperature: number
  maxTokens: number
  stream?: boolean
  json?: boolean
  debug?: boolean
}

export class LlmClient {
  private provider: 'bedrock' | 'openai' = 'bedrock'
  private bedrockModel?: string
  private openaiApiKey?: string
  private openaiModel: string = 'gpt-4o-mini'

  constructor(private toolManager: ToolManager) {}

  async ensureConfigured(preferredEndpoint?: string): Promise<void> {
    const llm = await getLlmConfig()
    if (!llm?.provider) {
      const {provider} = await inquirer.prompt([{type: 'list', name: 'provider', message: 'Choose LLM provider', choices: [
        {name: 'Amazon Bedrock', value: 'bedrock'},
        {name: 'OpenAI', value: 'openai'}
      ]}])
      if (provider === 'openai') {
        const {apiKey, model} = await inquirer.prompt([
          {type: 'password', name: 'apiKey', message: 'Enter OpenAI API key', mask: '*'},
          {type: 'input', name: 'model', message: 'OpenAI model', default: this.openaiModel}
        ])
        await setLlmConfig({provider: 'openai', openaiApiKey: apiKey, openaiModel: model})
      } else {
        const {model} = await inquirer.prompt([{type:'input', name:'model', message:'Bedrock model ID', default: process.env.BEDROCK_MODEL || 'us.amazon.nova-micro-v1:0'}])
        await setLlmConfig({provider: 'bedrock', openaiApiKey: undefined as any, openaiModel: undefined as any, currentEndpoint: model as any})
      }
    }

    const cfg = await getLlmConfig()
    this.provider = (cfg?.provider as any) || 'bedrock'
    if (this.provider === 'openai') {
      this.openaiApiKey = cfg?.openaiApiKey
      this.openaiModel = cfg?.openaiModel || this.openaiModel
    } else {
      this.bedrockModel = preferredEndpoint || (cfg?.currentEndpoint as any) || process.env.BEDROCK_MODEL || 'us.amazon.nova-micro-v1:0'
    }
  }

  getProviderLabel(): string {
    return this.provider === 'bedrock' ? 'Amazon Bedrock' : 'OpenAI'
  }

  buildSystemPrompt(): string {
    const today = new Date().toISOString().slice(0, 10)
    return SYSTEM_PROMPT_TEMPLATE.replaceAll('{{TODAY}}', today)
  }

  async send(messages: LlmMessage[], options: LlmOptions): Promise<{content: string; tool_calls?: ToolCall[]; raw?: any}> {
    if (this.provider === 'bedrock') {
      if (!this.bedrockModel) throw new Error('Bedrock model not configured')
      return this.callBedrock(messages, options)
    } else {
      return this.callOpenAI(messages, options)
    }
  }

  private buildKimiPrompt(messages: LlmMessage[], tools?: Tool[]): string {
    let prompt = ''
    for (const message of messages) {
      switch (message.role) {
        case 'system': prompt += `<|im_system|>system<|im_middle|>${message.content}<|im_end|>`; break
        case 'user': prompt += `<|im_user|>user<|im_middle|>${message.content}<|im_end|>`; break
        case 'assistant': prompt += `<|im_assistant|>assistant<|im_middle|>${message.content}<|im_end|>`; break
        case 'tool': prompt += `<|im_tool|>tool<|im_middle|>${message.content}<|im_end|>`; break
      }
    }
    if (tools && tools.length > 0) {
      const toolsPrompt = `\n\nAvailable tools:\n${tools.map(t => `${t.name}: ${t.description}`).join('\n')}\n\nYou can use tools by calling them with appropriate parameters.`
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

  private async callBedrock(messages: LlmMessage[], options: LlmOptions): Promise<any> {
    const {BedrockRuntimeClient, ConverseCommand} = await import('@aws-sdk/client-bedrock-runtime')
    const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
    const client = new BedrockRuntimeClient({region})
    const toolDefs = this.toolManager.getAllTools().map(t => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: {json: t.parameters as any}
      }
    }))
    const brMessages = messages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role, // Bedrock lacks explicit tool role; pass tool outputs as user content
      content: [{text: m.content}]
    }))
    const input = {
      modelId: this.bedrockModel!,
      conversationStateConfig: {}
    } as any
    const command = new ConverseCommand({
      modelId: this.bedrockModel!,
      inferenceConfig: {temperature: options.temperature, maxTokens: options.maxTokens},
      toolConfig: toolDefs.length ? {tools: toolDefs} : undefined,
      messages: brMessages
    } as any)
    try {
      const resp: any = await client.send(command)
      const text = resp?.output?.message?.content?.[0]?.text || ''
      // TODO: Map tool calls if using AgentCore primitives later
      return {content: text, tool_calls: undefined, raw: resp}
    } catch (e: any) {
      const msg = e?.message || String(e)
      return {content: `Error: ${msg}`, tool_calls: undefined, raw: {error: msg}}
    }
  }

  // Streaming via Bedrock will be implemented when available in this flow

  private async callOpenAI(messages: LlmMessage[], options: LlmOptions): Promise<any> {
    if (!this.openaiApiKey) throw new Error('OpenAI API key missing')
    // Expose only approved tools to OpenAI
    const allowed = this.toolManager.getAllTools().filter(t => ['analysis','get_current_time','calculate','read_file','write_file'].includes(t.name))
    const openAiTools = allowed.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
    const openAiMessages = messages.map(m => {
      if (m.role === 'tool' && m.tool_results && m.tool_results[0]?.call_id) {
        return { role: 'tool', tool_call_id: m.tool_results[0].call_id, content: m.content }
      }
      if (m.role === 'assistant' && (m as any).tool_calls && (m as any).tool_calls.length > 0) {
        const tcs = (m as any).tool_calls as ToolCall[]
        return {
          role: 'assistant',
          content: m.content || '',
          tool_calls: tcs.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }))
        } as any
      }
      return { role: m.role as any, content: m.content }
    })
    const payload = { model: this.openaiModel, temperature: options.temperature, max_tokens: options.maxTokens, tools: openAiTools, tool_choice: 'auto', messages: openAiMessages }
    try {
      const {stdout} = await execFileAsync('curl', ['-s', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${this.openaiApiKey}`, '-d', JSON.stringify(payload), 'https://api.openai.com/v1/chat/completions'])
      const response = JSON.parse(stdout)
      const msg = response?.choices?.[0]?.message
      const content = msg?.content || ''
      // Map tool calls if any
      const toolCalls: ToolCall[] | undefined = msg?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: safeParseJson(tc.function?.arguments)
      }))
      return {content, tool_calls: toolCalls, raw: response}
    } catch (e: any) {
      const msg = e?.stderr || e?.message || String(e)
      return {content: `Error: ${msg}`, tool_calls: undefined, raw: {error: msg}}
    }
  }

  async handleToolCycle(
    messages: LlmMessage[],
    options: LlmOptions,
    observer?: {
      onToolStart?: (call: ToolCall) => void
      onToolResult?: (call: ToolCall, result: string) => void
      onToolError?: (call: ToolCall, error: any) => void
      onStreamStart?: () => void
      onStreamToken?: (token: string) => void
      onStreamEnd?: () => void
    }
  ): Promise<{messages: LlmMessage[]; final: string}> {
    let finalContent = ''
    let steps = 0
    while (steps++ < 8) {
      const resp = await this.send(messages, options)
      if (resp.content) finalContent = resp.content
      messages.push({role: 'assistant', content: resp.content || '', tool_calls: resp.tool_calls})

      const calls = resp.tool_calls || []
      if (!calls.length) break

      for (const toolCall of calls) {
        try {
          observer?.onToolStart?.(toolCall)
          const result = await this.toolManager.executeTool(toolCall)
          observer?.onToolResult?.(toolCall, result)
          messages.push({role: 'tool', content: result, tool_results: [{call_id: toolCall.id, result}]})
        } catch (e: any) {
          const err = e?.message || String(e)
          const result = JSON.stringify({error: err})
          observer?.onToolError?.(toolCall, err)
          messages.push({role: 'tool', content: result, tool_results: [{call_id: toolCall.id, result}]})
        }
      }
      // Loop to ask the model again with tool results
      continue
    }
    // Final response without tool calls. Optionally stream it
    if (options.stream && observer?.onStreamToken) {
      if (this.provider === 'openai') {
        observer.onStreamStart?.()
        const streamed = await this.callOpenAIStream(messages, observer.onStreamToken)
        observer.onStreamEnd?.()
        finalContent = streamed
        messages.push({role: 'assistant', content: finalContent})
      }
    }
    return {messages, final: finalContent}
  }

  private async callOpenAIStream(messages: LlmMessage[], onToken: (t: string) => void): Promise<string> {
    const payload = {
      model: this.openaiModel,
      stream: true,
      messages: messages.map(m => ({role: m.role as any, content: m.content}))
    }
    const args = [
      '-s', '-N', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${this.openaiApiKey}`,
      '-d', JSON.stringify(payload),
      'https://api.openai.com/v1/chat/completions'
    ]
    return await new Promise<string>((resolve) => {
      const {spawn} = require('node:child_process') as typeof import('node:child_process')
      const child = spawn('curl', args)
      let final = ''
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { child.kill(); break }
          try {
            const json = JSON.parse(data)
            const delta = json?.choices?.[0]?.delta
            const token = delta?.content || ''
            if (token) {
              final += token
              onToken(token)
            }
          } catch {}
        }
      })
      child.on('close', () => resolve(final))
      child.on('error', () => resolve(final))
    })
  }
}

function safeParseJson(s: string | undefined): Record<string, any> {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return {} }
}
