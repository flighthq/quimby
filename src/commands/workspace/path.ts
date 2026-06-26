import { defineCommand } from 'citty'
import { resolveWorkspace } from '../../core/workspace.js'

export default defineCommand({
  meta: {
    name: 'path',
    description: 'Print the workspace directory path',
  },
  async run() {
    const { workspacePath } = await resolveWorkspace()
    console.log(workspacePath)
  },
})
