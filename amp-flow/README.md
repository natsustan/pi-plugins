# amp-flow

[pi](https://github.com/earendil-works/pi-mono) extensions that bring Amp
Code–style workflows to pi: **handoff**, **subagent**, and **/btw**.

Three cooperating extensions in one package:

| Extension | Entry point | What it does |
|-----------|-------------|--------------|
| handoff | `/handoff <goal>` + `handoff` tool | Generate a focused summary of the current conversation and start a new session seeded with it (non-lossy alternative to compaction). |
| subagent | `subagent` tool | Spawn one or more isolated in-process subagents with the built-in tools (read/bash/edit/write). Parallel, context-saving. |
| btw | `/btw <prompt>` | Run a background subagent with a live progress widget; result lands as a rendered chat message. Sees the current conversation. |

## Install

### 1. Link into pi's auto-discovered extensions dir

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /Users/spike/projects/pi-plugins/amp-flow ~/.pi/agent/extensions/amp-flow
```

### 2. Install the runtime dependency

The subagent loop uses `@earendil-works/pi-agent-core`, which pi does not inject
into extension scope. Install it locally:

```bash
cd /Users/spike/projects/pi-plugins/amp-flow
npm install
```

### 3. Reload

Run `/reload` in pi (or restart). The two commands and the two tools appear.

## Usage

### Handoff

When a conversation gets long or you want to branch into a focused task:

```
/handoff now implement this for teams as well
```

The summary is generated with the current session's model, then a new session
starts with the goal + parent-session reference + summary as the first prompt.
Navigate sessions with `/resume`.

The agent can also hand off when you ask explicitly ("hand this off to a new
session") — it calls the `handoff` tool, which switches after the current turn.

The new session inherits pi's default model. Switch with `/model` or `Ctrl+P`.

### Subagent

Ask the agent to "use subagents to …" for independent, context-hungry tasks.
The `subagent` tool accepts an array of task prompts; each becomes a parallel
subagent with a fresh context and the four built-in tools. Only the final text
summary of each returns to the parent.

Use sparingly — subagents are non-interactive and output tokens are expensive.

### /btw

```
/btw check if there are any TODO comments in src/
```

Runs a single background subagent that sees the current conversation. A live
widget above the editor shows tool calls as they happen. When it finishes, the
result renders as a chat message (filtered out of LLM context). Ask several in
parallel; each gets its own widget.

## Notes

- TUI-only. In RPC / JSON / print mode the commands are inert.
- The subagent/btw tools inherit the parent's **system prompt** and **thinking
  level**, but get a **fresh message history** (only `/btw` injects a serialized
  copy of the conversation).
- `handoff` tool-path uses a low-level `sessionManager.newSession()` plus a
  `context`-event message filter, since tool context lacks `newSession()`.

## Scope

| Surface | Status |
|---------|--------|
| `-mode` / `-model` flags | Not supported (would need a modes package + session-replacement model switching). Use `/model` after handoff. |
| Custom subagent tool sets | Not supported — always read/bash/edit/write. |
| Session-query (querying parent sessions) | Not included. |

## Restore / disable

Remove the symlink or the `extensions` entry, then `/reload`.
