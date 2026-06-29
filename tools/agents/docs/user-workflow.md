# User Workflow Context

This document captures the real-world workflow that quimby is designed to support, based on the project author's experience. It provides essential context for understanding why specific design decisions were made.

## Workflow Evolution

The author's multi-agent workflow evolved through these stages:

1. Claude in VS Code locally, single tab, reviewing work in own repo
2. Multiple Claude panels in VS Code over the same repo
3. Claude in Docker Sandbox in a VS Code terminal window
4. Git worktree for multiple lanes, multiple terminal windows, Docker Sandbox in each
5. Remote compute node via SSH, VS Code over SSH, same multi-lane pattern
6. tmux in one session to keep Docker Sandbox sessions running
7. SSH + named tmux session per lane + Docker Sandbox with claude in each
8. Custom scripts for bundling work, assigning tasks, and cross-lane communication

## Pain Points Driving the Design

### 1. Token Exhaustion

Reusing agent sessions left contexts open, burning through tokens quickly. This led to interest in using cheaper models (Sonnet, Ollama+qwen) for some agents, and ensuring sessions are ephemeral rather than long-lived.

**Quimby's answer**: Session-less model. Assignments go in, packs come out. No persistent context.

### 2. Model Flexibility

Different tasks warrant different models and different compute. Opus for hard architecture, Sonnet for routine work, Ollama on a GPU box for cheap exploration.

**Quimby's answer**: Agents are runtime-agnostic. The protocol (assignment.md, status.md, packs) is the same regardless of what agent or model runs inside the sandbox.

### 3. Manual Orchestration / Messenger Problem

The user becomes a messenger relaying problems between agents. Builder hits an issue → user reads status → user manually tells reviewer → reviewer responds → user relays back.

**Quimby's answer**: The server (`quimby serve`) polls agent status and routes updates via subscriptions. `quimby assign --pack` carries code artifacts between agents. The user orchestrates at a higher level instead of manually shuttling information.

### 4. Integration Bottleneck (Most Acute)

Gets a green repo in one lane, dispatches work in others, something goes wrong, does `git stash → git rebase → git stash pop → merge conflicts`. Work outpaces ability to integrate. The more agents producing work, the worse this gets.

**Quimby's answer**: Pack model with frozen baselines (`quimby/seed`). No stash/rebase mid-flight. Apply packs one at a time on clean branches. `quimby reset` to advance baselines after integration. The membrane ensures the user controls what enters the real repo.

## Key Insight

The fundamental tension is: **agents produce work faster than a human can integrate it.** Every design decision should be evaluated against whether it makes integration easier, not just whether it makes agent work easier. The membrane, packs, squashed-by-default apply, agent reset, and server-based routing all serve this goal.
