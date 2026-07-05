import { quimbyTmuxSocket } from '@quimbyhq/paths'

import { QUIMBY_ROOT_TMUX_OPTION, quimbyRootNewWindowBindingArgs } from './tmux'

export const DASHBOARD_PANEL_STATUS_RIGHT =
  '#[fg=colour240]alt+←→ tabs · shift+alt+←→ panes · alt+z zoom · ^b d close  #[fg=colour245]%H:%M '

export const DASHBOARD_STATUS_RIGHT =
  '#[fg=colour240]alt+←→ tabs · ^b r restart · ^b d exit  #[fg=colour245]%H:%M '

export const DASHBOARD_STATUS_LEFT = '#[fg=colour109,bold] quimby #[default]'

export const DASHBOARD_WRAPPER_STATUS_STYLE = 'bg=colour234,fg=colour245'

export const DASHBOARD_WINDOW_STATUS_CURRENT_STYLE = 'fg=colour231,bg=colour238,bold'

export const DASHBOARD_WINDOW_STATUS_FORMAT =
  '#{?window_silence_flag,#[fg=colour108]▎#[fg=colour244] #W ,#{?window_activity_flag,#[fg=colour109]▎#[fg=colour244] #W ,#[fg=colour240]▎#[fg=colour244] #W }}'

export const DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT =
  '#{?window_silence_flag,#[fg=colour108]▎#[fg=colour231] #W ,#{?window_activity_flag,#[fg=colour109]▎#[fg=colour231] #W ,#[fg=colour240]▎#[fg=colour231] #W }}'

export const DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD =
  '#{?pane_dead,#[fg=colour131]×#[fg=colour244]#W,#{?window_silence_flag,#[fg=colour108]▎#[fg=colour244]#W,#{?window_activity_flag,#[fg=colour109]▎#[fg=colour244]#W,#[fg=colour240]▎#[fg=colour244]#W}}}'

export const DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT_WITH_DEAD =
  '#{?pane_dead,#[fg=colour131]×#[fg=colour231]#W ,#{?window_silence_flag,#[fg=colour108]▎#[fg=colour231]#W ,#{?window_activity_flag,#[fg=colour109]▎#[fg=colour231]#W ,#[fg=colour240]▎#[fg=colour231]#W }}}'

export interface DashboardTmuxWindow {
  name: string
  cwd: string
  rootCwd?: string
  cmd: readonly string[]
  env?: readonly (readonly [string, string])[]
}

export function renderDashboardAttachCommand(session: string): string[] {
  return [...tmuxSocketArgs(), 'attach', '-t', session]
}

export function renderDashboardActivityCommands(session: string): string[][] {
  return [
    renderTmuxSetWindowGlobalOptionCommand('monitor-activity', 'on'),
    renderTmuxSetWindowGlobalOptionCommand('monitor-silence', '0'),
    renderTmuxSetGlobalOptionCommand('bell-action', 'none'),
    renderTmuxSetGlobalOptionCommand('activity-action', 'none'),
    renderTmuxSetGlobalOptionCommand('silence-action', 'none'),
    renderTmuxSetGlobalOptionCommand('visual-bell', 'off'),
    renderTmuxSetGlobalOptionCommand('visual-activity', 'off'),
    renderTmuxSetGlobalOptionCommand('visual-silence', 'off'),
    renderTmuxSetGlobalOptionCommand('window-status-activity-style', 'none'),
    renderTmuxSetGlobalOptionCommand('window-status-bell-style', 'none'),
    renderTmuxSetOptionCommand(session, 'activity-action', 'none'),
    renderTmuxSetOptionCommand(session, 'silence-action', 'none'),
    [
      ...tmuxSocketArgs(),
      'set-hook',
      '-g',
      'alert-activity',
      'set-window-option monitor-silence 30',
    ],
    [...tmuxSocketArgs(), 'set-hook', '-g', 'alert-silence', 'set-window-option monitor-silence 0'],
  ]
}

export function renderDashboardIndexCommands(session: string): string[][] {
  return [
    renderTmuxSetOptionCommand(session, 'base-index', '0'),
    renderTmuxSetOptionCommand(session, 'renumber-windows', 'on'),
    renderTmuxSetOptionCommand(
      session,
      'window-status-current-style',
      DASHBOARD_WINDOW_STATUS_CURRENT_STYLE,
    ),
    [...tmuxSocketArgs(), 'move-window', '-r', '-t', session],
  ]
}

export function renderDashboardKeyBindingCommands(): string[][] {
  const numberBindings = Array.from({ length: 9 }, (_, index) => [
    ...tmuxSocketArgs(),
    'bind',
    '-n',
    `M-${index + 1}`,
    'select-window',
    '-t',
    `:${index}`,
  ])
  return [
    [...tmuxSocketArgs(), 'bind', '-n', 'M-Left', 'previous-window'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-Right', 'next-window'],
    ...numberBindings,
    [...tmuxSocketArgs(), 'bind', 'r', 'respawn-window', '-k'],
    [
      ...tmuxSocketArgs(),
      'set-option',
      '-g',
      'remain-on-exit-format',
      '[quimby] #{window_name} exited (status #{pane_dead_status}) — <prefix> r restarts it',
    ],
  ]
}

export function renderDashboardStatusRightCommands(session: string): string[][] {
  return [
    renderTmuxSetOptionCommand(session, 'status-right-length', '80'),
    renderTmuxSetOptionCommand(session, 'status-right', DASHBOARD_STATUS_RIGHT),
  ]
}

export function renderDashboardChromeCommands(session: string): string[][] {
  return [
    renderTmuxSetOptionCommand(session, 'status-left', DASHBOARD_STATUS_LEFT),
    renderTmuxSetOptionCommand(session, 'window-status-separator', ''),
  ]
}

export function renderDashboardCreateSessionCommand(
  session: string,
  tmuxConf: string,
  first: Readonly<DashboardTmuxWindow>,
): string[] {
  return [
    ...tmuxSocketArgs(),
    '-f',
    tmuxConf,
    'new-session',
    '-d',
    '-s',
    session,
    '-n',
    first.name,
    '-c',
    first.cwd,
    ...renderTmuxEnvArgs(first),
    ...first.cmd,
  ]
}

export function renderDashboardMonitorCommands(session: string): string[][] {
  return DASHBOARD_MONITOR_OPTIONS.map(([option, value]) =>
    renderTmuxSetOptionCommand(session, option, value),
  )
}

export function renderDashboardNewWindowCommand(
  session: string,
  window: Readonly<DashboardTmuxWindow>,
): string[] {
  return [
    ...tmuxSocketArgs(),
    'new-window',
    '-t',
    session,
    '-n',
    window.name,
    '-c',
    window.cwd,
    ...renderTmuxEnvArgs(window),
    ...window.cmd,
  ]
}

export function renderDashboardPlanCommands(
  session: string,
  tmuxConf: string,
  windows: readonly DashboardTmuxWindow[],
): string[][] {
  const [first, ...rest] = windows
  return [
    renderDashboardCreateSessionCommand(session, tmuxConf, first),
    ...renderDashboardRootCommands(session, first.rootCwd ?? first.cwd),
    ...rest.map((window) => renderDashboardNewWindowCommand(session, window)),
    ...renderDashboardMonitorCommands(session),
    ...renderDashboardTabStatusCommands(session),
    ...renderDashboardChromeCommands(session),
    renderDashboardSelectFirstWindowCommand(session),
  ]
}

export function renderDashboardRootCommands(session: string, rootCwd: string): string[][] {
  return [
    [...tmuxSocketArgs(), ...quimbyRootNewWindowBindingArgs()],
    renderTmuxSetOptionCommand(session, QUIMBY_ROOT_TMUX_OPTION, rootCwd),
  ]
}

export function renderDashboardSelectFirstWindowCommand(session: string): string[] {
  return [...tmuxSocketArgs(), 'select-window', '-t', `${session}:0`]
}

export function renderDashboardTabStatusCommands(session: string): string[][] {
  return [
    renderTmuxSetOptionCommand(session, 'window-status-format', DASHBOARD_WINDOW_STATUS_FORMAT),
    renderTmuxSetOptionCommand(
      session,
      'window-status-current-format',
      DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT,
    ),
    renderTmuxSetOptionCommand(
      session,
      'window-status-current-style',
      DASHBOARD_WINDOW_STATUS_CURRENT_STYLE,
    ),
  ]
}

export function renderDashboardWindowTabStatusCommands(target: string): string[][] {
  return [
    renderTmuxSetWindowOptionCommand(
      target,
      'window-status-format',
      DASHBOARD_WINDOW_STATUS_FORMAT_WITH_DEAD,
    ),
    renderTmuxSetWindowOptionCommand(
      target,
      'window-status-current-format',
      DASHBOARD_WINDOW_STATUS_CURRENT_FORMAT_WITH_DEAD,
    ),
  ]
}

export function renderPanelDashboardActivityCommands(): string[][] {
  return [
    renderTmuxSetWindowGlobalOptionCommand('monitor-activity', 'on'),
    renderTmuxSetWindowGlobalOptionCommand('monitor-silence', '0'),
    renderTmuxSetGlobalOptionCommand('bell-action', 'none'),
    renderTmuxSetGlobalOptionCommand('activity-action', 'none'),
    renderTmuxSetGlobalOptionCommand('silence-action', 'none'),
    renderTmuxSetGlobalOptionCommand('visual-bell', 'off'),
    renderTmuxSetGlobalOptionCommand('visual-activity', 'off'),
    renderTmuxSetGlobalOptionCommand('visual-silence', 'off'),
    renderTmuxSetGlobalOptionCommand('window-status-activity-style', 'none'),
    renderTmuxSetGlobalOptionCommand('window-status-bell-style', 'none'),
    [
      ...tmuxSocketArgs(),
      'set-hook',
      '-g',
      'alert-activity',
      'set-window-option monitor-silence 30',
    ],
    [...tmuxSocketArgs(), 'set-hook', '-g', 'alert-silence', 'set-window-option monitor-silence 0'],
  ]
}

export function renderPanelDashboardChromeCommands(dashboard: string): string[][] {
  return [
    renderTmuxSetOptionCommand(dashboard, 'prefix', 'None'),
    renderTmuxSetOptionCommand(dashboard, 'mouse', 'on'),
    renderTmuxSetOptionCommand(dashboard, 'status', 'on'),
    renderTmuxSetOptionCommand(dashboard, 'status-style', DASHBOARD_WRAPPER_STATUS_STYLE),
    renderTmuxSetOptionCommand(dashboard, 'status-left', ''),
    renderTmuxSetOptionCommand(dashboard, 'status-right-length', '80'),
    renderTmuxSetOptionCommand(dashboard, 'status-right', DASHBOARD_PANEL_STATUS_RIGHT),
    renderTmuxSetOptionCommand(dashboard, 'window-status-format', ''),
    renderTmuxSetOptionCommand(dashboard, 'window-status-current-format', ''),
  ]
}

export function renderPanelDashboardKeyBindingCommands(): string[][] {
  return [
    [...tmuxSocketArgs(), 'bind', '-n', 'M-Left', 'send-keys', 'C-b', 'p'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-Right', 'send-keys', 'C-b', 'n'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-S-Left', 'select-pane', '-L'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-S-Right', 'select-pane', '-R'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-S-Up', 'select-pane', '-U'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-S-Down', 'select-pane', '-D'],
    [...tmuxSocketArgs(), 'bind', '-n', 'M-z', 'resize-pane', '-Z'],
  ]
}

export function renderTmuxEnvArgs(window: Readonly<DashboardTmuxWindow>): string[] {
  return (window.env ?? []).flatMap(([key, value]) => ['-e', `${key}=${value}`])
}

export function renderTmuxSetGlobalOptionCommand(option: string, value: string): string[] {
  return [...tmuxSocketArgs(), 'set-option', '-g', option, value]
}

export function renderTmuxSetOptionCommand(
  target: string,
  option: string,
  value: string,
): string[] {
  return [...tmuxSocketArgs(), 'set-option', '-t', target, option, value]
}

export function renderTmuxSetWindowGlobalOptionCommand(option: string, value: string): string[] {
  return [...tmuxSocketArgs(), 'set-window-option', '-g', option, value]
}

export function renderTmuxSetWindowOptionCommand(
  target: string,
  option: string,
  value: string,
): string[] {
  return [...tmuxSocketArgs(), 'set-window-option', '-t', target, option, value]
}

export function tmuxSocketArgs(): string[] {
  return ['-L', quimbyTmuxSocket]
}

const DASHBOARD_MONITOR_OPTIONS: [string, string][] = [
  ['monitor-activity', 'on'],
  ['monitor-silence', '30'],
  ['bell-action', 'none'],
  ['activity-action', 'none'],
  ['silence-action', 'none'],
  ['visual-bell', 'off'],
  ['visual-activity', 'off'],
  ['visual-silence', 'off'],
  ['window-status-activity-style', 'none'],
  ['window-status-bell-style', 'none'],
]
