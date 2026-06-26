import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'workspace',
    description: 'Workspace introspection',
  },
  subCommands: {
    path: () => import('./path.js').then((m) => m.default),
    size: () => import('./size.js').then((m) => m.default),
  },
})
