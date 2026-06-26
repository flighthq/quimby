import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'sandbox',
    description: 'Manage sandboxes',
  },
  subCommands: {
    add: () => import('./add.js').then((m) => m.default),
    list: () => import('./list.js').then((m) => m.default),
    start: () => import('./start.js').then((m) => m.default),
    stop: () => import('./stop.js').then((m) => m.default),
    assign: () => import('./assign.js').then((m) => m.default),
    status: () => import('./status.js').then((m) => m.default),
    refresh: () => import('./refresh.js').then((m) => m.default),
  },
})
