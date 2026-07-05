import { describe, expect, it } from 'vitest'

import {
  DASHBOARD_PANEL_STATUS_RIGHT,
  DASHBOARD_STATUS_LEFT,
  DASHBOARD_STATUS_RIGHT,
  DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT,
  DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT_WITH_DEAD,
  DASHBOARD_WINDOW_STATUS_CURRENT_STYLE,
  DASHBOARD_WINDOW_STATUS_FORMAT,
  DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD,
  DASHBOARD_WRAPPER_STATUS_STYLE,
  renderDashboardActivityCommands,
  renderDashboardAttachCommand,
  renderDashboardChromeCommands,
  renderDashboardCreateSessionCommand,
  renderDashboardIndexCommands,
  renderDashboardKeyBindingCommands,
  renderDashboardMonitorCommands,
  renderDashboardNewWindowCommand,
  renderDashboardPlanCommands,
  renderDashboardRootCommands,
  renderDashboardSelectFirstWindowCommand,
  renderDashboardStatusRightCommands,
  renderDashboardTabStatusCommands,
  renderDashboardWindowTabStatusCommands,
  renderPanelDashboardActivityCommands,
  renderPanelDashboardChromeCommands,
  renderPanelDashboardKeyBindingCommands,
  renderTmuxEnvArgs,
  renderTmuxSetGlobalOptionCommand,
  renderTmuxSetOptionCommand,
  renderTmuxSetWindowGlobalOptionCommand,
  renderTmuxSetWindowOptionCommand,
  tmuxSocketArgs,
} from './dashboardTmux'

describe('dashboard tmux constants', () => {
  it('renders the panel status hint separately from tab strips', () => {
    expect(DASHBOARD_PANEL_STATUS_RIGHT).toContain('shift+alt+←→ panes')
    expect(DASHBOARD_PANEL_STATUS_RIGHT).toContain('%H:%M')
    expect(DASHBOARD_STATUS_RIGHT).toContain('^b r restart')
  })

  it('renders tab status formats as fixed cellular strings', () => {
    expectTabCell(DASHBOARD_WINDOW_STATUS_FORMAT, 'colour244')
    expectTabCell(DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT, 'colour231')
    expect(DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD).toContain('pane_dead')
    expectTabCell(DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD, 'colour244')
    expectTabCell(DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT_WITH_DEAD, 'colour231')
    expect(DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD).not.toContain('▎#[fg=colour244]#W')
    expect(DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT_WITH_DEAD).not.toContain('▎#[fg=colour231]#W')
    expect(DASHBOARD_WINDOW_STATUS_CURRENT_STYLE).toBe('fg=colour231,bg=colour238,bold')
    expect(DASHBOARD_WRAPPER_STATUS_STYLE).toBe('bg=colour234,fg=colour245')
  })

  it('keeps the dashboard label free of a standalone separator', () => {
    expect(DASHBOARD_STATUS_LEFT).toBe('#[fg=colour109,bold] quimby #[default]')
    expect(DASHBOARD_STATUS_LEFT).not.toContain('│')
  })
})

function expectTabCell(format: string, titleColour: string): void {
  const titleCell = `#[fg=${titleColour}] #W `
  expect(format).toContain(`▎${titleCell}`)
  expect(format).not.toContain(`#[fg=${titleColour}]  #W `)
  expect(format).not.toContain(`#[fg=${titleColour}] #W  `)
}

describe('renderDashboardActivityCommands', () => {
  it('renders global activity hooks and session action suppression', () => {
    const flat = renderDashboardActivityCommands('dash').map((cmd) => cmd.join(' '))
    expect(flat).toContain('-L quimby set-window-option -g monitor-activity on')
    expect(flat).toContain('-L quimby set-option -t dash activity-action none')
    expect(flat).toContain(
      '-L quimby set-hook -g alert-silence set-window-option monitor-silence 0',
    )
  })
})

describe('renderDashboardAttachCommand', () => {
  it('renders the attach command on the quimby tmux socket', () => {
    expect(renderDashboardAttachCommand('dash')).toEqual(['-L', 'quimby', 'attach', '-t', 'dash'])
  })
})

describe('renderDashboardChromeCommands', () => {
  it('renders label and separator commands', () => {
    expect(renderDashboardChromeCommands('dash')).toEqual([
      ['-L', 'quimby', 'set-option', '-t', 'dash', 'status-left', DASHBOARD_STATUS_LEFT],
      ['-L', 'quimby', 'set-option', '-t', 'dash', 'window-status-separator', ''],
    ])
  })
})

describe('renderDashboardCreateSessionCommand', () => {
  it('renders the detached first-window command', () => {
    expect(
      renderDashboardCreateSessionCommand('dash', '/tmux.conf', {
        name: 'host',
        cwd: '/repo',
        cmd: ['bash', '-l'],
      }),
    ).toEqual([
      '-L',
      'quimby',
      '-f',
      '/tmux.conf',
      'new-session',
      '-d',
      '-s',
      'dash',
      '-n',
      'host',
      '-c',
      '/repo',
      'bash',
      '-l',
    ])
  })
})

describe('renderDashboardIndexCommands', () => {
  it('renders base-index, renumber, current style, and move-window commands', () => {
    expect(renderDashboardIndexCommands('dash')).toEqual([
      ['-L', 'quimby', 'set-option', '-t', 'dash', 'base-index', '0'],
      ['-L', 'quimby', 'set-option', '-t', 'dash', 'renumber-windows', 'on'],
      [
        '-L',
        'quimby',
        'set-option',
        '-t',
        'dash',
        'window-status-current-style',
        DASHBOARD_WINDOW_STATUS_CURRENT_STYLE,
      ],
      ['-L', 'quimby', 'move-window', '-r', '-t', 'dash'],
    ])
  })
})

describe('renderDashboardKeyBindingCommands', () => {
  it('renders tab navigation and restart bindings', () => {
    const flat = renderDashboardKeyBindingCommands().map((cmd) => cmd.join(' '))
    expect(flat).toContain('-L quimby bind -n M-Left previous-window')
    expect(flat).toContain('-L quimby bind -n M-9 select-window -t :8')
    expect(flat).toContain('-L quimby bind r respawn-window -k')
  })
})

describe('renderDashboardMonitorCommands', () => {
  it('renders quiet monitor and alert suppression options', () => {
    const flat = renderDashboardMonitorCommands('dash').map((cmd) => cmd.join(' '))
    expect(flat).toContain('-L quimby set-option -t dash monitor-activity on')
    expect(flat).toContain('-L quimby set-option -t dash monitor-silence 30')
    expect(flat).toContain('-L quimby set-option -t dash window-status-activity-style none')
  })
})

describe('renderDashboardNewWindowCommand', () => {
  it('renders a new-window command with env args', () => {
    expect(
      renderDashboardNewWindowCommand('dash', {
        name: 'builder',
        cwd: '/agent',
        cmd: ['bash', '-lc', 'codex'],
        env: [['K', 'v']],
      }),
    ).toEqual([
      '-L',
      'quimby',
      'new-window',
      '-t',
      'dash',
      '-n',
      'builder',
      '-c',
      '/agent',
      '-e',
      'K=v',
      'bash',
      '-lc',
      'codex',
    ])
  })
})

describe('renderDashboardPlanCommands', () => {
  it('composes session, root, windows, monitor, tab, chrome, and selection commands', () => {
    const commands = renderDashboardPlanCommands('dash', '/tmux.conf', [
      { name: 'host', cwd: '/repo', rootCwd: '/repo', cmd: ['bash', '-l'] },
      { name: 'builder', cwd: '/agent', cmd: ['bash', '-lc', 'codex'] },
    ])
    expect(commands[0]).toEqual(expect.arrayContaining(['new-session', '-s', 'dash']))
    expect(commands.some((cmd) => cmd.includes('@quimby-root'))).toBe(true)
    expect(commands.some((cmd) => cmd.includes('new-window') && cmd.includes('builder'))).toBe(true)
    expect(commands.some((cmd) => cmd.includes('window-status-current-format'))).toBe(true)
    expect(commands.at(-1)).toEqual(renderDashboardSelectFirstWindowCommand('dash'))
  })
})

describe('renderDashboardRootCommands', () => {
  it('binds prefix+c and records the root cwd', () => {
    const flat = renderDashboardRootCommands('dash', '/repo').map((cmd) => cmd.join(' '))
    expect(flat[0]).toContain('bind c new-window -c #{?@quimby-root')
    expect(flat[1]).toBe('-L quimby set-option -t dash @quimby-root /repo')
  })
})

describe('renderDashboardSelectFirstWindowCommand', () => {
  it('selects window zero', () => {
    expect(renderDashboardSelectFirstWindowCommand('dash')).toEqual([
      '-L',
      'quimby',
      'select-window',
      '-t',
      'dash:0',
    ])
  })
})

describe('renderDashboardStatusRightCommands', () => {
  it('renders the flat-dashboard status hint', () => {
    expect(renderDashboardStatusRightCommands('dash')).toEqual([
      ['-L', 'quimby', 'set-option', '-t', 'dash', 'status-right-length', '80'],
      ['-L', 'quimby', 'set-option', '-t', 'dash', 'status-right', DASHBOARD_STATUS_RIGHT],
    ])
  })
})

describe('renderDashboardTabStatusCommands', () => {
  it('renders session-scoped tab status commands', () => {
    expect(renderDashboardTabStatusCommands('dash')).toEqual([
      [
        '-L',
        'quimby',
        'set-option',
        '-t',
        'dash',
        'window-status-format',
        DASHBOARD_WINDOW_STATUS_FORMAT,
      ],
      [
        '-L',
        'quimby',
        'set-option',
        '-t',
        'dash',
        'window-status-current-format',
        DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT,
      ],
      [
        '-L',
        'quimby',
        'set-option',
        '-t',
        'dash',
        'window-status-current-style',
        DASHBOARD_WINDOW_STATUS_CURRENT_STYLE,
      ],
    ])
  })
})

describe('renderDashboardWindowTabStatusCommands', () => {
  it('renders per-window tab formats with dead-pane state', () => {
    expect(renderDashboardWindowTabStatusCommands('dash:1')).toEqual([
      [
        '-L',
        'quimby',
        'set-window-option',
        '-t',
        'dash:1',
        'window-status-format',
        DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD,
      ],
      [
        '-L',
        'quimby',
        'set-window-option',
        '-t',
        'dash:1',
        'window-status-current-format',
        DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT_WITH_DEAD,
      ],
    ])
  })
})

describe('renderPanelDashboardActivityCommands', () => {
  it('renders wrapper-level activity hooks without a session target', () => {
    const flat = renderPanelDashboardActivityCommands().map((cmd) => cmd.join(' '))
    expect(flat).toContain('-L quimby set-window-option -g monitor-silence 0')
    expect(flat).toContain('-L quimby set-option -g visual-silence off')
    expect(flat).toContain(
      '-L quimby set-hook -g alert-activity set-window-option monitor-silence 30',
    )
  })
})

describe('renderPanelDashboardChromeCommands', () => {
  it('renders wrapper status bar commands', () => {
    const flat = renderPanelDashboardChromeCommands('dash').map((cmd) => cmd.join(' '))
    expect(flat).toContain('-L quimby set-option -t dash prefix None')
    expect(flat).toContain(
      `-L quimby set-option -t dash status-style ${DASHBOARD_WRAPPER_STATUS_STYLE}`,
    )
    expect(flat).toContain(
      `-L quimby set-option -t dash status-right ${DASHBOARD_PANEL_STATUS_RIGHT}`,
    )
    expect(flat).toContain('-L quimby set-option -t dash window-status-format ')
  })
})

describe('renderPanelDashboardKeyBindingCommands', () => {
  it('renders pane wrapper navigation bindings', () => {
    const flat = renderPanelDashboardKeyBindingCommands().map((cmd) => cmd.join(' '))
    expect(flat).toContain('-L quimby bind -n M-Left send-keys C-b p')
    expect(flat).toContain('-L quimby bind -n M-S-Down select-pane -D')
    expect(flat).toContain('-L quimby bind -n M-z resize-pane -Z')
  })
})

describe('renderTmuxEnvArgs', () => {
  it('renders tmux environment arguments', () => {
    expect(renderTmuxEnvArgs({ name: 'x', cwd: '/', cmd: [], env: [['K', 'v']] })).toEqual([
      '-e',
      'K=v',
    ])
  })
})

describe('renderTmuxSetGlobalOptionCommand', () => {
  it('renders set-option -g on the quimby tmux socket', () => {
    expect(renderTmuxSetGlobalOptionCommand('visual-bell', 'off')).toEqual([
      '-L',
      'quimby',
      'set-option',
      '-g',
      'visual-bell',
      'off',
    ])
  })
})

describe('renderTmuxSetOptionCommand', () => {
  it('renders set-option on the quimby tmux socket', () => {
    expect(renderTmuxSetOptionCommand('dash', 'status', 'on')).toEqual([
      '-L',
      'quimby',
      'set-option',
      '-t',
      'dash',
      'status',
      'on',
    ])
  })
})

describe('renderTmuxSetWindowGlobalOptionCommand', () => {
  it('renders set-window-option -g on the quimby tmux socket', () => {
    expect(renderTmuxSetWindowGlobalOptionCommand('monitor-activity', 'on')).toEqual([
      '-L',
      'quimby',
      'set-window-option',
      '-g',
      'monitor-activity',
      'on',
    ])
  })
})

describe('renderTmuxSetWindowOptionCommand', () => {
  it('renders set-window-option on the quimby tmux socket', () => {
    expect(renderTmuxSetWindowOptionCommand('dash:1', 'remain-on-exit', 'on')).toEqual([
      '-L',
      'quimby',
      'set-window-option',
      '-t',
      'dash:1',
      'remain-on-exit',
      'on',
    ])
  })
})

describe('tmuxSocketArgs', () => {
  it('targets the dedicated quimby tmux socket', () => {
    expect(tmuxSocketArgs()).toEqual(['-L', 'quimby'])
  })
})
