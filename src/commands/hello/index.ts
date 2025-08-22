import {Args, Command, Flags} from '@oclif/core'

export default class Hello extends Command {
	static description = 'Say hello to someone'

	static args = {
		person: Args.string({name: 'person', description: 'Name to greet', required: true}),
	}

	static flags = {
		from: Flags.string({description: 'Who is saying hello', default: 'oclif'}),
	}

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Hello)
		this.log(`hello ${args.person} from ${flags.from}!`)
	}
}