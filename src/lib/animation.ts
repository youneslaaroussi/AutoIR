export class AnimatedLogo {
  private frame = 0
  private logos: string[] = [
    `
    ███████╗██╗   ██╗████████╗ ██████╗ ██╗██████╗ 
    ██╔══██║██║   ██║╚══██╔══╝██╔═══██╗██║██╔══██╗
    ███████║██║   ██║   ██║   ██║   ██║██║██████╔╝
    ██╔══██║██║   ██║   ██║   ██║   ██║██║██╔══██╗
    ██║  ██║╚██████╔╝   ██║   ╚██████╔╝██║██║  ██║
    ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═╝╚═╝  ╚═╝`,
  ]
  private initialized = true

  constructor() {}

  public renderToGrid(width: number, height: number): string[] {
    if (!this.initialized) {
      return Array(height).fill('').map(() => ' '.repeat(width))
    }

    this.frame += 1
    
    // Cycle through different logo styles
    const logoIndex = Math.floor(this.frame / 60) % this.logos.length
    const currentLogo = this.logos[logoIndex]
    
    // Add some simple animation effects
    const pulse = Math.sin(this.frame * 0.1) * 0.5 + 0.5
    const dots = '.'.repeat(Math.floor(pulse * 5))
    
    // Split logo into lines and center it
    const logoLines = currentLogo.split('\n')
    const result: string[] = []
    
    // Add padding at top
    const topPadding = Math.floor((height - logoLines.length - 2) / 2)
    for (let i = 0; i < topPadding; i++) {
      result.push(' '.repeat(width))
    }
    
    // Add logo lines (centered)
    for (const line of logoLines) {
      const padding = Math.floor((width - line.length) / 2)
      const centeredLine = ' '.repeat(Math.max(0, padding)) + line + ' '.repeat(Math.max(0, width - line.length - padding))
      result.push(centeredLine.slice(0, width))
    }
    
    // Add animated loading indicator
    const loadingLine = `Initializing${dots}`
    const loadingPadding = Math.floor((width - loadingLine.length) / 2)
    const centeredLoading = ' '.repeat(Math.max(0, loadingPadding)) + loadingLine + ' '.repeat(Math.max(0, width - loadingLine.length - loadingPadding))
    result.push(centeredLoading.slice(0, width))
    
    // Fill remaining space
    while (result.length < height) {
      result.push(' '.repeat(width))
    }
    
    return result.slice(0, height)
  }
}

// Keep backward compatibility
export class RotatingSphere extends AnimatedLogo {}
