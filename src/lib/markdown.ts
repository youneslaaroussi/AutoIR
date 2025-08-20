// Minimal Markdown -> blessed tag renderer for bold, italics, headings, lists, inline/code blocks
// Note: blessed supports {bold}, {underline}, {inverse}, and {color-fg}. No italic, we map to underline/dim.

export function markdownToBlessed(input: string): string {
  if (!input) return ''

  // Handle code blocks ```
  const lines = input.split(/\r?\n/)
  const out: string[] = []
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      if (inCode) {
        out.push('{yellow-fg}')
      } else {
        out.push('{/yellow-fg}')
      }
      continue
    }
    if (inCode) {
      out.push(escapeBlessedTags(line))
      continue
    }

    // Headings ###, ##, # → bold
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`{bold}${escapeBlessedTags(heading[2])}{/bold}`)
      continue
    }

    // Lists - or *
    if (/^\s*[-*]\s+/.test(line)) {
      const text = line.replace(/^\s*[-*]\s+/, '')
      out.push(`  • ${inlineFormat(text)}`)
      continue
    }

    out.push(inlineFormat(line))
  }

  return out.join('\n')
}

function inlineFormat(s: string): string {
  let t = escapeBlessedTags(s)
  // Bold **text**
  t = t.replace(/\*\*(.+?)\*\*/g, '{bold}$1{/bold}')
  // Italic *text* (map to underline)
  t = t.replace(/(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/g, ($0, pre, inner) => `${pre}{underline}${inner}{/underline}`)
  // Inline code `code`
  t = t.replace(/`([^`]+)`/g, '{yellow-fg}$1{/yellow-fg}')
  return t
}

function escapeBlessedTags(s: string): string {
  // Escape curly braces used by blessed tags
  return s.replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}
