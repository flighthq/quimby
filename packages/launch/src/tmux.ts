import { sq } from '@quimbyhq/transport'

export const QUIMBY_ROOT_TMUX_OPTION = '@quimby-root'
export const QUIMBY_ROOT_TMUX_FORMAT = '#{?@quimby-root,#{@quimby-root},#{pane_current_path}}'

export function quimbyRootNewWindowBindingArgs(): string[] {
  return ['bind', 'c', 'new-window', '-c', QUIMBY_ROOT_TMUX_FORMAT]
}

export function tmuxSetQuimbyRootShell(
  rootCwd: string,
  opts: Readonly<{ socket?: string; target?: string }> = {},
): string {
  const tmux = opts.socket ? `tmux -L ${sq(opts.socket)}` : 'tmux'
  const target = opts.target ?? '"$TMUX_PANE"'
  return (
    `__quimby_root=${sq(rootCwd)}; ` +
    `__quimby_root="\${__quimby_root/#~/$HOME}"; ` +
    `${tmux} set-option -t ${target} ${QUIMBY_ROOT_TMUX_OPTION} "$__quimby_root" 2>/dev/null; `
  )
}
