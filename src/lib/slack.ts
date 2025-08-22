import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import https from 'node:https'
import {getSlackConfig, setSlackConfig} from './config.js'

const execFileAsync = promisify(execFile)

export async function sendSlackWebhook(webhookUrl: string, text: string): Promise<void> {
	const payload = JSON.stringify({ text })
	await new Promise<void>((resolve, reject) => {
		const url = new URL(webhookUrl)
		const req = https.request({
			method: 'POST',
			hostname: url.hostname,
			path: url.pathname + url.search,
			headers: {'Content-Type': 'application/json'}
		}, res => {
			if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve()
			else reject(new Error(`Webhook HTTP ${res.statusCode}`))
		})
		req.on('error', reject)
		req.write(payload)
		req.end()
	})
}

export async function sendSlackBotMessage(botToken: string, channel: string, text: string): Promise<{ts: string}> {
	const args = ['-sS','-X','POST','-H',`Authorization: Bearer ${botToken}`,'-H','Content-Type: application/json','-d', JSON.stringify({channel, text}), 'https://slack.com/api/chat.postMessage']
	const {stdout} = await execFileAsync('curl', args)
	const resp = safeJson(stdout)
	if (!resp?.ok) throw new Error(resp?.error || 'Slack API error')
	return {ts: resp.ts || resp.message?.ts || ''}
}

export async function lookupChannelId(botToken: string, channelName: string): Promise<string> {
	const args = ['-sS','-H',`Authorization: Bearer ${botToken}`,'-H','Content-Type: application/x-www-form-urlencoded','--data-urlencode','limit=1000','https://slack.com/api/conversations.list']
	const {stdout} = await execFileAsync('curl', args)
	const resp = safeJson(stdout)
	if (!resp?.ok) throw new Error(resp?.error || 'Slack API error')
	const match = (resp.channels || []).find((c: any) => c.name === channelName || c.id === channelName)
	if (!match) throw new Error(`Channel ${channelName} not found`)
	return match.id
}

export async function validateSlackBot(botToken: string): Promise<{ok: boolean; team?: string; user?: string}> {
	const args = ['-sS','-H',`Authorization: Bearer ${botToken}`,'https://slack.com/api/auth.test']
	const {stdout} = await execFileAsync('curl', args)
	const resp = safeJson(stdout)
	return {ok: !!resp?.ok, team: resp?.team, user: resp?.user}
}

export async function saveSlackBotConfig(botToken: string, channelId: string, channelName?: string): Promise<void> {
	const cfg = await getSlackConfig()
	await setSlackConfig({ ...(cfg || {}), botToken, channelId, channelName })
}

function safeJson(s: string): any { try { return JSON.parse(s) } catch { return {} } }