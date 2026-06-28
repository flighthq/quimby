import { describe, expect, it } from 'vitest'

import { renderWorkerClaudeMd } from './template'

describe('renderWorkerClaudeMd', () => {
  it('includes the worker name', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output).toContain('alice')
  })

  it('references repo/CLAUDE.md', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output).toContain('@repo/CLAUDE.md')
  })

  it('includes assignment section', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output).toContain('assignment.md')
  })

  it('includes status section', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output).toContain('status.md')
  })

  it('includes inbox section', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output).toContain('inbox/')
  })

  it('mentions the repo/ directory', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output).toContain('repo/')
  })

  it('uses the worker name in the header', () => {
    const output = renderWorkerClaudeMd({ workerName: 'my-worker' })
    expect(output).toContain('**my-worker**')
  })

  it('ends with a newline', () => {
    const output = renderWorkerClaudeMd({ workerName: 'alice' })
    expect(output.endsWith('\n')).toBe(true)
  })
})
