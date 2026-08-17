import { getAgentAttestation, getAgentHeadHash, rebaseAgentOntoBase } from '@quimbyhq/agent'
import { handoffWork } from '@quimbyhq/handoff'
import { nudgeAgentSession } from '@quimbyhq/session'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { resolve } from 'pathe'

import { attestationResolver, formatAttestation } from '../attestation'
import { resolveNudgeFocusOptions } from '../focus'
import { consolaReporter } from '../reporter'

export default defineCommand({
  meta: {
    name: 'handoff',
    description: "Carry an agent's work to another agent, or your host's work to an agent",
  },
  args: {
    from: {
      type: 'positional',
      description: 'Source agent — or, used alone, the recipient (host → it)',
      required: true,
    },
    to: {
      type: 'positional',
      description: 'Recipient agent (when a source agent is given)',
      required: false,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: "The parcel's note",
    },
    attach: {
      type: 'string',
      description: "Carry a different agent's diff than the source",
    },
    code: {
      type: 'boolean',
      description:
        "Carry the host's working-tree diff. --no-code sends only the note and any --file attachments",
      default: true,
    },
    file: {
      type: 'string',
      description:
        "Attach a host file to the parcel (repeatable). Lands in the recipient's inbox, outside its repo/ — so it can never be committed or ride a diff back. Host → agent only",
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the code source onto host HEAD before packaging',
      default: false,
    },
    nudge: {
      type: 'boolean',
      description:
        'Wake the recipient via its tmux session. Default: nudge only when the parcel carries a note (-m); --nudge / --no-nudge force it',
    },
    clear: {
      type: 'boolean',
      alias: 'c',
      description: "Type '/clear' first to reset the recipient's context, then send the nudge",
      default: false,
    },
  },
  run: runHandoffCommand,
})

export async function runHandoffCommand({
  args,
}: {
  args: {
    from: string
    to?: string
    message?: string
    attach?: string
    code?: boolean
    file?: string | string[]
    rebase: boolean
    nudge?: boolean
    clear: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  // Relay the code source's self-attestation (its own diff is what's carried) — informational.
  // The host has none; an `--attach` overrides which agent's work (and attestation) travels.
  const codeSource = args.attach ?? args.from
  if (state.agents[codeSource]) {
    const src = state.agents[codeSource]
    const [att, liveHash] = await Promise.all([
      getAgentAttestation(repoRoot, state.id, src),
      getAgentHeadHash(repoRoot, state.id, src),
    ])
    logger.info(`check: ${formatAttestation(att, liveHash)}`)
  }

  const result = await handoffWork(
    {
      state,
      repoRoot,
      from: args.from,
      to: args.to,
      message: args.message,
      userDirected: Boolean(args.message),
      // Handing over a file rarely means "and also everything uncommitted in my checkout". The
      // diff stays the default (a handoff is a code channel first), but it has to be refusable, or
      // `--file` drags unrelated host work into an agent as a side effect of an attachment.
      noteOnly: args.code === false,
      attach: args.attach,
      // citty yields a bare string for one `--file` and an array for several; resolving against
      // cwd keeps a relative path meaning what the user typed rather than what the repo root is.
      files: toArray(args.file).map((path) => resolve(path)),
      nudge: args.nudge,
      beforeStage: args.rebase
        ? (name) => rebaseAgentOntoBase(repoRoot, name, consolaReporter).then(() => undefined)
        : undefined,
      resolveAttestation: attestationResolver(repoRoot, state),
    },
    consolaReporter,
  )

  if (result.nudgeText !== null) {
    await nudgeAgentSession({
      agent: state.agents[result.to],
      clear: args.clear,
      displayName: result.to,
      courier: `${result.userDirected ? 'delegated task' : 'parcel'} ${result.parcelName} from ${result.from}`,
      ...(await resolveNudgeFocusOptions(repoRoot, state, result.to)),
      reporter: consolaReporter,
    })
  }
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}
