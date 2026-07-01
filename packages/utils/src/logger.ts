import { createConsola } from 'consola'

// Drop the per-line timestamp: consola renders it as a right-aligned `quimby <time>`
// badge that reflows to an inline `[quimby <time>]` on long lines, which reads as noise
// in CLI output. The `quimby` tag stays; only the date is suppressed.
export const logger = createConsola({ formatOptions: { date: false } }).withTag('quimby')
