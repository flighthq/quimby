import { colors } from 'consola/utils'

// figlet-style "quimby" wordmark shown atop the root help output. The glyphs
// embed backticks, so the lines cannot be template literals.
const BANNER_LINES = [
  '.88888.            oo            dP',
  "d8'   `8b                         88",
  '88     88  dP    dP dP 88d8b.d8b. 88d888b. dP    dP',
  "88  db 88  88    88 88 88'`88'`88 88'  `88 88    88",
  'Y8.  Y88P  88.  .88 88 88  88  88 88.  .88 88.  .88',
  " `8888PY8b `88888P' dP dP  dP  dP 88Y8888' `8888P88",
  '                                                .88',
  '                                            d8888P',
]

export function getQuimbyBanner(): string {
  return BANNER_LINES.map((line) => colors.cyan(line)).join('\n')
}
