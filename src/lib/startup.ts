import blessed from 'blessed'
import {RotatingSphere} from './animation.js'

export interface StartupProcess {
  name: string
  description: string
  run: (updateStatus?: (message: string) => void) => Promise<any>
}

export interface StartupConfig {
  title: string
  processes: StartupProcess[]
  animationEnabled?: boolean
}

export class StartupScreen {
  private screen: blessed.Widgets.Screen
  private sphere: RotatingSphere
  private animationInterval?: NodeJS.Timeout
  private container!: blessed.Widgets.BoxElement
  private titleBox!: blessed.Widgets.BoxElement
  private animationBox!: blessed.Widgets.BoxElement
  private statusBox!: blessed.Widgets.BoxElement
  private instructionsBox!: blessed.Widgets.BoxElement

  constructor(private config: StartupConfig) {
    this.sphere = new RotatingSphere()
    this.screen = blessed.screen({
      smartCSR: true,
      title: config.title
    })
    this.createUI()
  }

  private createUI() {
    // Main container
    this.container = blessed.box({
      parent: this.screen,
      width: '100%',
      height: '100%',
      style: {
        bg: 'black'
      }
    })

    // Title
    this.titleBox = blessed.box({
      parent: this.container,
      content: `{center}{bold}${this.config.title}{/bold}{/center}`,
      top: 2,
      height: 3,
      width: '100%',
      tags: true,
      style: {
        fg: 'cyan',
        bg: 'black'
      }
    })

    // Animation area
    this.animationBox = blessed.box({
      parent: this.container,
      top: 6,
      left: 'center',
      width: 100,
      height: 30,
      style: {
        fg: 'white',
        bg: 'black'
      }
    })

    // Status area
    this.statusBox = blessed.box({
      parent: this.container,
      top: 38,
      left: 'center', 
      width: 80,
      height: 8,
      border: {
        type: 'line'
      },
      label: ' Status ',
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'cyan'
        }
      },
      content: 'Initializing...',
      scrollable: true
    })

    // Instructions
    this.instructionsBox = blessed.box({
      parent: this.container,
      bottom: 1,
      height: 1,
      width: '100%',
      content: '{center}Press q or Ctrl+C to quit{/center}',
      tags: true,
      style: {
        fg: 'yellow',
        bg: 'black'
      }
    })

    // Quit handlers
    this.screen.key(['q', 'C-c'], () => {
      this.cleanup()
      process.exit(0)
    })
  }

  private startAnimation() {
    if (!this.config.animationEnabled) return

    this.animationInterval = setInterval(() => {
      const frame = this.sphere.renderToGrid(98, 28) // Use full width
      const content = frame.join('\n')
      this.animationBox.setContent(content)
      this.screen.render()
    }, 50) // 20 FPS
  }

  private stopAnimation() {
    if (this.animationInterval) {
      clearInterval(this.animationInterval)
      this.animationInterval = undefined
    }
  }

  public async runStartup(): Promise<any[]> {
    this.screen.render()
    this.startAnimation()

    const results = []
    
    try {
      for (let i = 0; i < this.config.processes.length; i++) {
        const process = this.config.processes[i]
        
        // Update status
        this.updateStatus(`[${i + 1}/${this.config.processes.length}] ${process.description}...`)
        
        try {
          const result = await process.run((message: string) => {
            this.updateStatus(`[${i + 1}/${this.config.processes.length}] ${process.description}... ${message}`)
          })
          results.push({name: process.name, success: true, result})
          this.updateStatus(`[${i + 1}/${this.config.processes.length}] ${process.description}... DONE`)
        } catch (error: any) {
          results.push({name: process.name, success: false, error})
          this.updateStatus(`[${i + 1}/${this.config.processes.length}] ${process.description}... ERROR: ${error.message}`)
          
          // Wait a bit to show the error
          await new Promise(resolve => setTimeout(resolve, 2000))
          throw error
        }
        
        // Small delay between processes
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      
      this.updateStatus('Initialization complete! Starting application...')
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      return results
      
    } finally {
      this.stopAnimation()
    }
  }

  private updateStatus(message: string) {
    const currentContent = this.statusBox.getContent()
    const newContent = currentContent + '\n' + message
    this.statusBox.setContent(newContent)
    this.statusBox.setScrollPerc(100) // Auto-scroll to bottom
    this.screen.render()
  }

  public cleanup() {
    this.stopAnimation()
    if (this.screen) {
      this.screen.destroy()
    }
  }

  public getScreen(): blessed.Widgets.Screen {
    return this.screen
  }
}
