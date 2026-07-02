import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'

import { exists } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agentDir,
  agentEdit,
  agentRepoDir,
  agentState,
  createTempWorkspace,
  git,
  runQuimby,
  type TempWorkspace,
} from './support'

// Suite A — the courier lifecycle end to end, driving the real built CLI against a throwaway
// workspace with `-r local`. The harness "plays the agent" by writing into its repo/ between
// commands; every assertion is a real on-disk effect (parcels, ledgers, the target repo, the seed).

let ws: TempWorkspace
let dir: string

async function run(args: string[]) {
  return runQuimby(dir, args)
}

/** `quimby add` writes .gitignore; committing it gives the clean tree `merge` requires. */
async function addAgentAndCommitIgnore(name: string) {
  const res = await run(['add', name, '-r', 'local', '-c', 'true'])
  expect(res.exitCode, res.output).toBe(0)
  await git(dir, 'add', '.gitignore')
  // -A picks up .gitignore only the first time; ignore the "nothing to commit" on later adds.
  await git(dir, 'commit', '-m', `ignore .quimby (${name})`).catch(() => {})
}

async function inboxParcels(agent: string): Promise<string[]> {
  const inbox = `${await agentDir(dir, agent)}/inbox`
  const entries = await readdir(inbox).catch(() => [] as string[])
  return entries.filter((e) => e !== 'status' && !e.startsWith('.'))
}

beforeEach(async () => {
  ws = await createTempWorkspace()
  dir = ws.dir
})

afterEach(async () => {
  await ws.cleanup()
})

describe('Suite A — courier lifecycle (real CLI, -r local)', () => {
  it('add scaffolds the agent and records it in state', async () => {
    await addAgentAndCommitIgnore('builder')
    const agent = await agentState(dir, 'builder')
    expect(agent.id).toMatch(/[0-9a-f-]{36}/)
    const adir = await agentDir(dir, 'builder')
    expect(await exists(`${adir}/assignment.md`)).toBe(true)
    expect(await exists(`${adir}/status.md`)).toBe(true)
    expect(await exists(`${await agentRepoDir(dir, 'builder')}/.git`)).toBe(true)
    const list = await run(['list'])
    expect(list.output).toContain('builder')
  })

  it('assign writes assignment.md', async () => {
    await addAgentAndCommitIgnore('builder')
    const res = await run(['assign', 'builder', '-m', 'implement the parser', '--no-nudge'])
    expect(res.exitCode, res.output).toBe(0)
    const assignment = await readFile(`${await agentDir(dir, 'builder')}/assignment.md`, 'utf-8')
    expect(assignment).toContain('implement the parser')
  })

  it('diff previews the agent working tree; status reports agent-written status', async () => {
    await addAgentAndCommitIgnore('builder')
    await agentEdit(dir, 'builder', { 'feature.txt': 'new feature\n' }, 'add feature')
    const diff = await run(['diff', 'builder'])
    expect(diff.output).toContain('feature.txt')

    await writeFile(`${await agentDir(dir, 'builder')}/status.md`, 'halfway through the parser')
    const status = await run(['status', 'builder'])
    expect(status.output).toContain('halfway through the parser')
  })

  it('handoff carries an agent parcel (note + diff) into the recipient inbox', async () => {
    await addAgentAndCommitIgnore('builder')
    await addAgentAndCommitIgnore('reviewer')
    await agentEdit(dir, 'builder', { 'feature.txt': 'new feature\n' }, 'add feature')

    const res = await run(['handoff', 'builder', 'reviewer', '-m', 'please review', '--no-nudge'])
    expect(res.exitCode, res.output).toBe(0)

    const parcels = await inboxParcels('reviewer')
    expect(parcels).toHaveLength(1)
    expect(parcels[0]).toMatch(/^builder-/)
    const pdir = `${await agentDir(dir, 'reviewer')}/inbox/${parcels[0]}`
    expect(await exists(`${pdir}/meta.yaml`)).toBe(true)
    expect(await readFile(`${pdir}/README.md`, 'utf-8')).toContain('please review')
    expect(await readFile(`${pdir}/squashed.diff`, 'utf-8')).toContain('feature.txt')
  })

  it('handoff with one positional carries the host working tree to the agent', async () => {
    await addAgentAndCommitIgnore('reviewer')
    // A host-side change (uncommitted) becomes the parcel body; sender is the reserved "host".
    await writeFile(`${dir}/hostwork.txt`, 'local tweak\n')

    const res = await run(['handoff', 'reviewer', '-m', 'look at my local tweak', '--no-nudge'])
    expect(res.exitCode, res.output).toBe(0)

    const parcels = await inboxParcels('reviewer')
    expect(parcels).toHaveLength(1)
    expect(parcels[0]).toMatch(/^host-/)
    const pdir = `${await agentDir(dir, 'reviewer')}/inbox/${parcels[0]}`
    expect(await readFile(`${pdir}/squashed.diff`, 'utf-8')).toContain('hostwork.txt')
  })

  it('dispatch enacts an agent-authored outbox and moves the draft to .sent', async () => {
    await addAgentAndCommitIgnore('reviewer')
    await addAgentAndCommitIgnore('builder')
    // The reviewer authors a note addressed to builder in its outbox.
    const reviewerOutbox = `${await agentDir(dir, 'reviewer')}/outbox/builder`
    await mkdir(reviewerOutbox, { recursive: true })
    await writeFile(`${reviewerOutbox}/README.md`, 'fix the null case in Y')

    const res = await run(['dispatch', 'reviewer', '--no-nudge'])
    expect(res.exitCode, res.output).toBe(0)

    // It lands in builder's inbox…
    const parcels = await inboxParcels('builder')
    expect(parcels).toHaveLength(1)
    expect(parcels[0]).toMatch(/^reviewer-/)
    // …and the draft is drained from the active outbox into the .sent ledger.
    expect(await exists(`${reviewerOutbox}/README.md`)).toBe(false)
    const sent = await readdir(`${await agentDir(dir, 'reviewer')}/outbox/.sent/builder`).catch(
      () => [] as string[],
    )
    expect(sent.length).toBeGreaterThan(0)
  })

  it('merge (squashed) lands the work in the target and advances the seed', async () => {
    await addAgentAndCommitIgnore('builder')
    await agentEdit(dir, 'builder', { 'feature.txt': 'new feature\n' }, 'add feature')
    const seedBefore = (await agentState(dir, 'builder')).seedCommit

    const res = await run(['merge', 'builder', '-m', 'land builder work'])
    expect(res.exitCode, res.output).toBe(0)

    expect(await exists(`${dir}/feature.txt`)).toBe(true)
    // Workspace state never leaks into the merge.
    expect(await git(dir, 'ls-files')).not.toContain('.quimby')
    // A clean committed landing advances the seed onto what landed.
    const seedAfter = (await agentState(dir, 'builder')).seedCommit
    expect(seedAfter).not.toBe(seedBefore)
    expect(seedAfter).toBe(await git(dir, 'rev-parse', 'HEAD'))
  })

  it('merge --commits replays the agent commits', async () => {
    await addAgentAndCommitIgnore('builder')
    await agentEdit(dir, 'builder', { 'a.txt': 'a\n' }, 'first change')
    await agentEdit(dir, 'builder', { 'b.txt': 'b\n' }, 'second change')

    const res = await run(['merge', 'builder', '--commits'])
    expect(res.exitCode, res.output).toBe(0)
    const log = await git(dir, 'log', '--format=%s')
    expect(log).toContain('first change')
    expect(log).toContain('second change')
  })

  it('merge --patch leaves the work uncommitted in the target working tree', async () => {
    await addAgentAndCommitIgnore('builder')
    await agentEdit(dir, 'builder', { 'feature.txt': 'new feature\n' }, 'add feature')

    const res = await run(['merge', 'builder', '--patch'])
    expect(res.exitCode, res.output).toBe(0)
    expect(await exists(`${dir}/feature.txt`)).toBe(true)
    // Uncommitted: feature.txt shows as a pending change, not a commit.
    expect(await git(dir, 'status', '--porcelain')).toContain('feature.txt')
    expect(await git(dir, 'log', '--format=%s')).not.toContain('feature')
  })

  it('merge -b parks the work on a branch and leaves the checkout unchanged', async () => {
    await addAgentAndCommitIgnore('builder')
    await agentEdit(dir, 'builder', { 'feature.txt': 'new feature\n' }, 'add feature')
    const branchBefore = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

    const res = await run(['merge', 'builder', '-m', 'land on branch', '-b', 'feature/land'])
    expect(res.exitCode, res.output).toBe(0)

    // The work is on the landing branch…
    expect(await git(dir, 'ls-tree', '--name-only', 'feature/land')).toContain('feature.txt')
    // …but the user's checkout is exactly where it started, and clean (the -b restore fix).
    expect(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore)
    expect(await git(dir, 'ls-tree', '--name-only', 'HEAD')).not.toContain('feature.txt')
    expect(await git(dir, 'status', '--porcelain')).toBe('')
  })

  it('merge surfaces a real conflict and leaves it in progress', async () => {
    await addAgentAndCommitIgnore('builder')
    await agentEdit(dir, 'builder', { 'README.md': '# agent version\n' }, 'edit readme')
    // The host diverges on the same file after the agent's seed, forcing a genuine conflict.
    await writeFile(`${dir}/README.md`, '# host version\n')
    await git(dir, 'commit', '-am', 'host edits readme')

    const res = await run(['merge', 'builder', '-m', 'try to land'])
    expect(res.exitCode).not.toBe(0)
    expect(res.output.toLowerCase()).toContain('conflict')
    // The merge is left in progress for the user to resolve with normal git tooling.
    expect(await exists(`${dir}/.git/MERGE_HEAD`)).toBe(true)
  })

  it('sync -f drops the agent work but keeps its mailbox', async () => {
    await addAgentAndCommitIgnore('builder')
    await addAgentAndCommitIgnore('reviewer')
    // Deliver a parcel so the mailbox has content, then give the agent throwaway work.
    await run(['handoff', 'reviewer', 'builder', '-m', 'a note', '--no-nudge'])
    await agentEdit(dir, 'builder', { 'scratch.txt': 'wip\n' }, 'scratch work')
    expect((await run(['diff', 'builder'])).output).toContain('scratch.txt')

    const res = await run(['sync', 'builder', '-f'])
    expect(res.exitCode, res.output).toBe(0)
    // Work is gone…
    expect((await run(['diff', 'builder'])).output).not.toContain('scratch.txt')
    // …but the delivered parcel is untouched.
    expect(await inboxParcels('builder')).toHaveLength(1)
  })

  it('rebuild --force resets the agent and clears its mailbox', async () => {
    await addAgentAndCommitIgnore('builder')
    await addAgentAndCommitIgnore('reviewer')
    await run(['handoff', 'reviewer', 'builder', '-m', 'a note', '--no-nudge'])
    await writeFile(`${await agentDir(dir, 'builder')}/status.md`, 'busy')
    expect(await inboxParcels('builder')).toHaveLength(1)

    const res = await run(['rebuild', 'builder', '--force'])
    expect(res.exitCode, res.output).toBe(0)
    expect(await inboxParcels('builder')).toHaveLength(0)
    expect(await readFile(`${await agentDir(dir, 'builder')}/status.md`, 'utf-8')).toBe('idle')
  })

  it('rename relabels the agent without moving its directory', async () => {
    await addAgentAndCommitIgnore('builder')
    const before = await agentState(dir, 'builder')

    const dirBefore = await agentDir(dir, 'builder')
    const res = await run(['rename', 'builder', 'maker'])
    expect(res.exitCode, res.output).toBe(0)
    const after = await agentState(dir, 'maker')
    expect(after.id).toBe(before.id)
    // Same UUID-keyed directory — a pure relabel, so the on-disk dir never moves.
    expect(await agentDir(dir, 'maker')).toBe(dirBefore)
    expect(await exists(dirBefore)).toBe(true)
  })

  it('remove deletes the agent and its directory', async () => {
    await addAgentAndCommitIgnore('builder')
    const adir = await agentDir(dir, 'builder')
    const res = await run(['remove', 'builder', '--force'])
    expect(res.exitCode, res.output).toBe(0)
    expect(await exists(adir)).toBe(false)
    const list = await run(['list'])
    expect(list.output).not.toContain('builder')
  })
})
