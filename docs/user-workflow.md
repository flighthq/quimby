# User Workflow Context

This document captures the real-world workflow that ao is designed to support, based on the project author's experience. It provides essential context for understanding why specific design decisions were made.

## Workflow Evolution

The author's multi-agent workflow evolved through these stages:

1. Claude in VS Code locally, single tab, reviewing work in own repo
2. Multiple Claude panels in VS Code over the same repo
3. Claude in Docker Sandbox in a VS Code terminal window
4. Git worktree for multiple lanes, multiple terminal windows, Docker Sandbox in each
5. Remote compute node via SSH, VS Code over SSH, same multi-lane pattern
6. tmux in one session to keep Docker Sandbox sessions running
7. SSH + named tmux session per lane + Docker Sandbox with claude in each
8. Custom scripts: `send:worktree` (bundle), `get:worktree` (bundle), `assign:worktree` (assignment), with protocol for status updates, questions, and cross-lane diff review

## Existing Directory Structure

```
project-name/
  main/              # the real repo
  worktrees/
    tree-name/       # git worktree per lane
```

VS Code opened to browse agent-generated files at will. This spatial layout — the real repo in one place, agent work in adjacent directories — is a pattern ao should support via `ao init --workspace`.

## Pain Points Driving the Design

### 1. Token Exhaustion
Reusing agent sessions left contexts open, burning through tokens quickly. This led to interest in using cheaper models (Sonnet, Ollama+qwen) for some lanes, and ensuring sessions are ephemeral rather than long-lived.

**ao's answer**: Session-less model. Assignments go in, bundles come out. No persistent context.

### 2. Model Flexibility
Different tasks warrant different models and different compute. Opus for hard architecture, Sonnet for routine work, Ollama on a GPU box for cheap exploration.

**ao's answer**: The `runtime` config supports heterogeneous sandboxes — different runtimes, different machines, different models. The protocol is the same regardless of what's running inside.

### 3. Manual Orchestration / Messenger Problem
The user becomes a messenger relaying problems between agents. Builder agent hits an issue → user reads status → user manually tells reviewer → reviewer responds → user relays back. "Dropping an assignment feels nice" but cross-lane communication is manual.

**ao's answer**: `receives` config for automatic bundle routing. `messages/` channel for cross-lane dialogue. `ao watch` for automation. Future: coordinator agent that reads status and dispatches follow-up assignments.

### 4. Integration Bottleneck (Most Acute)
Gets a green repo in one lane, dispatches work in others, something goes wrong, does `git stash → git rebase → git stash pop → merge conflicts`. Work outpaces ability to integrate. The more agents producing work, the worse this gets.

**ao's answer**: Bundle model with frozen baselines (`ao/seed`). No stash/rebase mid-flight. Apply bundles one at a time on clean branches. `ao sandbox refresh` to advance baselines after integration. The membrane ensures the user controls what enters the real repo.

## Key Insight

The fundamental tension is: **agents produce work faster than a human can integrate it.** Every design decision should be evaluated against whether it makes integration easier, not just whether it makes agent work easier. The membrane, bundles, squashed-by-default apply, sandbox refresh, and auto-routing all serve this goal.
