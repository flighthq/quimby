import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'bundle',
    description: 'Manage bundles',
  },
  subCommands: {
    create: () => import('./create.js').then((m) => m.default),
    list: () => import('./list.js').then((m) => m.default),
    review: () => import('./review.js').then((m) => m.default),
    apply: () => import('./apply.js').then((m) => m.default),
    send: () => import('./send.js').then((m) => m.default),
  },
})
