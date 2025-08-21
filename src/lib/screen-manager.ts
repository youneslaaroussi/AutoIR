import blessed from 'blessed'

export interface Screen {
  name: string
  key: string
  description: string
  render(screen: blessed.Widgets.Screen, context: any): Promise<void>
  cleanup?(): void
}

export interface ScreenContext {
  dbPool?: any
  smEndpoint?: string
  smRegion?: string
  flags: any
  state: any
}

export class ScreenManager {
  private screens: Map<string, Screen> = new Map()
  private currentScreen?: Screen
  private blessedScreen: blessed.Widgets.Screen
  private context: ScreenContext

  constructor(context: ScreenContext) {
    this.context = context
    this.blessedScreen = blessed.screen({ 
      smartCSR: true, 
      title: 'AutoIR - Intelligent Log Analysis Platform',
      fullUnicode: true
    })

    // Global quit handler
    this.blessedScreen.key(['q', 'C-c'], () => {
      this.cleanup()
      process.exit(0)
    })
  }

  registerScreen(screen: Screen): void {
    this.screens.set(screen.key, screen)
  }

  async showMenuScreen(): Promise<void> {
    this.blessedScreen.destroy()
    this.blessedScreen = blessed.screen({ 
      smartCSR: true, 
      title: 'AutoIR - Screen Selection',
      fullUnicode: true
    })

    const container = blessed.box({
      parent: this.blessedScreen,
      width: '100%',
      height: '100%',
      style: { bg: 'black' }
    })

    const title = blessed.box({
      parent: container,
      top: 2,
      height: 3,
      width: '100%',
      content: '{center}{bold}{cyan-fg}AutoIR{/cyan-fg}{/bold} — Choose a Screen{/center}',
      tags: true,
      style: { fg: 'white' }
    })

    const menuBox = blessed.box({
      parent: container,
      top: 6,
      left: 'center',
      width: '60%',
      height: this.screens.size + 6,
      border: { type: 'line' },
      label: ' Available Screens ',
      style: {
        fg: 'white',
        bg: 'black',
        border: { fg: 'cyan' }
      },
      tags: true
    })

    let content = '\n'
    for (const screen of this.screens.values()) {
      content += `  {yellow-fg}${screen.key.toUpperCase()}{/yellow-fg} - ${screen.description}\n`
    }
    content += '\n  {yellow-fg}Q{/yellow-fg} - Quit\n'

    menuBox.setContent(content)

    const footer = blessed.box({
      parent: container,
      bottom: 1,
      height: 1,
      width: '100%',
      content: '{center}Press a key to select a screen{/center}',
      tags: true,
      style: { fg: 'gray' }
    })

    // Handle screen selection
    for (const screen of this.screens.values()) {
      this.blessedScreen.key([screen.key, screen.key.toUpperCase()], async () => {
        await this.switchToScreen(screen.key)
      })
    }

    this.blessedScreen.key(['q', 'Q', 'C-c'], () => {
      this.cleanup()
      process.exit(0)
    })

    this.blessedScreen.render()
  }

  async switchToScreen(key: string): Promise<void> {
    const screen = this.screens.get(key)
    if (!screen) return

    // Cleanup current screen
    if (this.currentScreen?.cleanup) {
      this.currentScreen.cleanup()
    }

    this.currentScreen = screen
    
    // Recreate blessed screen for clean state
    this.blessedScreen.destroy()
    this.blessedScreen = blessed.screen({ 
      smartCSR: true, 
      title: `AutoIR - ${screen.name}`,
      fullUnicode: true
    })

    // Add global navigation keys
    this.blessedScreen.key(['escape'], async () => {
      await this.showMenuScreen()
    })

    this.blessedScreen.key(['q', 'C-c'], () => {
      this.cleanup()
      process.exit(0)
    })

    // Render the screen
    await screen.render(this.blessedScreen, this.context)
  }

  cleanup(): void {
    if (this.currentScreen?.cleanup) {
      this.currentScreen.cleanup()
    }
    this.blessedScreen.destroy()
  }
}
