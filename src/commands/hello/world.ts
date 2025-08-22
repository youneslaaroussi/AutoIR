import {Command} from '@oclif/core'

export default class HelloWorld extends Command {
	static description = 'Say hello world'
	async run(): Promise<void> {
		this.log('hello world!')
	}
}