import { describe, expect, it } from 'vitest'

import {
  QUIMBY_ROOT_TMUX_FORMAT,
  QUIMBY_ROOT_TMUX_OPTION,
  quimbyRootNewWindowBindingArgs,
  tmuxSetQuimbyRootShell,
} from './tmux'

describe('quimbyRootNewWindowBindingArgs', () => {
  it('binds `c` to open a new window at the quimby-root format', () => {
    const args = quimbyRootNewWindowBindingArgs()
    expect(args).toEqual(['bind', 'c', 'new-window', '-c', QUIMBY_ROOT_TMUX_FORMAT])
    // The format reads the recorded root option, falling back to the pane path.
    expect(QUIMBY_ROOT_TMUX_FORMAT).toBe('#{?@quimby-root,#{@quimby-root},#{pane_current_path}}')
  })

  it('uses the option-or-pane-path format so a window inherits the recorded root', () => {
    const args = quimbyRootNewWindowBindingArgs()
    // The `-c` value falls back to the pane's current path when the option is unset.
    expect(args.at(-1)).toContain(QUIMBY_ROOT_TMUX_OPTION)
    expect(args.at(-1)).toContain('pane_current_path')
  })
})

describe('tmuxSetQuimbyRootShell', () => {
  it('sets the quimby-root option from the given cwd on the current pane by default', () => {
    const cmd = tmuxSetQuimbyRootShell('/repo/project')
    expect(cmd).toContain(`__quimby_root='/repo/project'`)
    expect(cmd).toContain(
      `tmux set-option -t "$TMUX_PANE" ${QUIMBY_ROOT_TMUX_OPTION} "$__quimby_root"`,
    )
    // No socket given → plain `tmux`, not `tmux -L …`.
    expect(cmd).not.toContain('-L')
  })

  it('expands a leading ~ to $HOME so the root is an absolute path', () => {
    const cmd = tmuxSetQuimbyRootShell('~/work')
    expect(cmd).toContain('${__quimby_root/#~/$HOME}')
  })

  it('single-quotes the cwd, escaping embedded single quotes', () => {
    const cmd = tmuxSetQuimbyRootShell(`/tmp/o'brien`)
    expect(cmd).toContain(`__quimby_root='/tmp/o'"'"'brien'`)
  })

  it('routes through the quimby socket when one is given', () => {
    const cmd = tmuxSetQuimbyRootShell('/repo', { socket: 'quimby' })
    expect(cmd).toContain(`tmux -L 'quimby' set-option`)
  })

  it('targets an explicit tmux target when provided', () => {
    const cmd = tmuxSetQuimbyRootShell('/repo', { target: 'qb-proj-a1' })
    expect(cmd).toContain('set-option -t qb-proj-a1')
    expect(cmd).not.toContain('$TMUX_PANE')
  })

  it('silences set-option errors and ends in a command separator', () => {
    const cmd = tmuxSetQuimbyRootShell('/repo')
    expect(cmd).toContain('2>/dev/null')
    expect(cmd.trimEnd().endsWith(';')).toBe(true)
  })
})
