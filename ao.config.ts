import { defineWorkspace } from 'agent-orchestrator'

export default defineWorkspace({
  source: { ref: 'main' },
  sandboxes: {
    worker: {
      role: 'General-purpose development agent',
      runtime: {
        type: 'docker-sandbox',
        launch: () => ['sbx', 'run', 'claude'],
      },
    },
  },
})
