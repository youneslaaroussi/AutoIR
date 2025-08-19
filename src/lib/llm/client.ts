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
  private provider: 'aws' | 'openai' = 'aws'
  private endpoint?: string
  private openaiApiKey?: string
  private openaiModel: string = 'gpt-4o-mini'

  constructor(private toolManager: ToolManager) {}

  async ensureConfigured(preferredEndpoint?: string): Promise<void> {
    const llm = await getLlmConfig()
    if (!llm?.provider) {
      const {provider} = await inquirer.prompt([{type: 'list', name: 'provider', message: 'Choose LLM provider', choices: [
        {name: 'AWS self-hosted (Kimi K2)', value: 'aws'},
        {name: 'OpenAI', value: 'openai'}
      ]}])
      if (provider === 'openai') {
        const {apiKey, model} = await inquirer.prompt([
          {type: 'password', name: 'apiKey', message: 'Enter OpenAI API key', mask: '*'},
          {type: 'input', name: 'model', message: 'OpenAI model', default: this.openaiModel}
        ])
        await setLlmConfig({provider: 'openai', openaiApiKey: apiKey, openaiModel: model})
      } else {
        await setLlmConfig({provider: 'aws', currentEndpoint: preferredEndpoint})
      }
    }

    const cfg = await getLlmConfig()
    this.provider = (cfg?.provider as any) || 'aws'
    if (this.provider === 'openai') {
      this.openaiApiKey = cfg?.openaiApiKey
      this.openaiModel = cfg?.openaiModel || this.openaiModel
    } else {
      this.endpoint = preferredEndpoint || cfg?.currentEndpoint
    }
  }

  getProviderLabel(): string {
    return this.provider === 'aws' ? 'Kimi K2 (AWS)' : 'OpenAI'
  }

  buildSystemPrompt(): string {
    const today = new Date().toISOString().slice(0, 10)
    return SYSTEM_PROMPT_TEMPLATE.replaceAll('{{TODAY}}', today)
  }

  async send(messages: LlmMessage[], options: LlmOptions): Promise<{content: string; tool_calls?: ToolCall[]; raw?: any}> {
    if (this.provider === 'aws') {
      if (!this.endpoint) throw new Error('AWS/Kimi K2 endpoint not configured')
      const prompt = this.buildKimiPrompt(messages, this.toolManager.getAllTools())
      return this.callKimiK2(this.endpoint, prompt, options)
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

  private async callKimiK2(endpoint: string, prompt: string, options: LlmOptions): Promise<any> {
    const payload = {prompt, temperature: options.temperature, min_p: 0.01, n_predict: options.maxTokens, stream: options.stream}
    const {stdout} = await execFileAsync('curl', ['-s', '-f', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify(payload), `${endpoint}/completion`])
    const response = JSON.parse(stdout)
    return {content: response.content || '', tool_calls: response.tool_calls || [], raw: response}
  }

  private async callOpenAI(messages: LlmMessage[], options: LlmOptions): Promise<any> {
    if (!this.openaiApiKey) throw new Error('OpenAI API key missing')
    const payload = {model: this.openaiModel, temperature: options.temperature, max_tokens: options.maxTokens, messages: messages.filter(m => m.role !== 'tool').map(m => ({role: m.role as any, content: m.content}))}
    const {stdout} = await execFileAsync('curl', ['-s', '-f', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${this.openaiApiKey}`, '-d', JSON.stringify(payload), 'https://api.openai.com/v1/chat/completions'])
    const response = JSON.parse(stdout)
    const content = response?.choices?.[0]?.message?.content || ''
    return {content, raw: response}
  }

  async handleToolCycle(messages: LlmMessage[], options: LlmOptions): Promise<{messages: LlmMessage[]; final: string}> {
    const first = await this.send(messages, options)
    messages.push({role: 'assistant', content: first.content || '', tool_calls: first.tool_calls})
    if (first.tool_calls && first.tool_calls.length > 0) {
      for (const toolCall of first.tool_calls) {
        const result = await this.toolManager.executeTool(toolCall)
        messages.push({role: 'tool', content: result, tool_results: [{call_id: toolCall.id, result}]})
      }
      const follow = await this.send(messages, options)
      messages.push({role: 'assistant', content: follow.content || ''})
      return {messages, final: follow.content || ''}
    }
    return {messages, final: first.content || ''}
  }
}
