import { spawn } from 'node:child_process'

/**
 * Page `text` through the user's pager when attached to a TTY, so long output (a diff, a
 * full status) doesn't scroll off the terminal history. Prints plainly when piped or when
 * the pager can't be spawned. Honors `GIT_PAGER`/`PAGER`, defaulting to `less -RFX`.
 */
export async function page(text: string): Promise<void> {
  if (!process.stdout.isTTY) {
    console.log(text) // eslint-disable-line no-console
    return
  }
  const pager = process.env.GIT_PAGER || process.env.PAGER || 'less -RFX'
  await new Promise<void>((resolve) => {
    const child = spawn(pager, { stdio: ['pipe', 'inherit', 'inherit'], shell: true })
    child.on('error', () => {
      console.log(text) // eslint-disable-line no-console
      resolve()
    })
    child.on('close', () => resolve())
    child.stdin.on('error', () => {}) // user quit the pager early — ignore EPIPE
    child.stdin.write(text)
    child.stdin.end()
  })
}
