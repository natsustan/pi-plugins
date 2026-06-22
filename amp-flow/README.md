# amp-flow

[pi](https://github.com/earendil-works/pi-mono) extensions that bring Amp
Code–style workflows to pi: **handoff**, **subagent**, and **/btw**.

Three cooperating extensions (plus a `session_query` tool and a
`session-query` skill) in one package:

| Extension | Entry point | What it does |
|-----------|-------------|--------------|
| handoff | `/handoff [-mode <name>] [-model <id>] <goal>` + `handoff` tool | Generate a focused summary of the current conversation and start a new session seeded with it (non-lossy alternative to compaction). Restores the current model+thinking, or applies `-mode`/`-model`. |
| subagent | `subagent` tool | Spawn one or more isolated in-process subagents with the active built-in tools (read/write/edit/bash + grep/find/ls). Parallel, context-saving. |
| btw | `/btw <prompt>` | Run a background subagent with a live progress widget; result lands as a rendered chat message. Sees the current conversation. |
| session-query | `session_query` tool | Query any `.jsonl` session file (e.g. a handoff parent) for context/decisions, using that session's own model. |

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

Run `/reload` in pi (or restart). The command and the two tools appear.

## Usage

### Handoff

When a conversation gets long or you want to branch into a focused task:

```
/handoff now implement this for teams as well
/handoff -mode rush execute phase one of the plan
/handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
```

Optional flags (can be combined):
- `-mode <name>` — start the new session in a named modes.json preset (e.g.
  `rush`, `smart`, `deep`), applying its model + thinking level.
- `-model <provider/id>` — start the new session with a specific model.

Without flags, the new session inherits the **current** session's model +
thinking (restored explicitly, since the underlying session replacement would
otherwise reset to pi's default). The summary is always generated with the
current session's model before switching.

The generated prompt includes a **Parent session** reference; load the bundled
`session-query` skill so the new session can look the parent up via the
`session_query` tool. Navigate sessions with `/resume`.

### Subagent

Ask the agent to "use subagents to …" for independent, context-hungry tasks.
The `subagent` tool accepts an array of task prompts; each becomes a parallel
subagent with a fresh context and the active built-in tools
(read / write / edit / bash, plus grep / find / ls when enabled). Only the
final text summary of each returns to the parent.

`tool_call` / `tool_result` events from subagents are forwarded to any
`tool_call` hooks registered by extensions loaded **after** amp-flow (e.g. a
policy extension); hooks from extensions loaded **before** amp-flow aren't
visible to it and won't apply to subagent calls.

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
- `handoff` command-path uses `ctx.newSession()` with a `globalThis` stash so
  the new session's `session_start` handler can apply the prompt + model options
  with a fresh `pi` (the old one is stale after session replacement). The
  tool-path uses the low-level `sessionManager.newSession()` in an `agent_end`
  handler, since tool context lacks `newSession()`.

## Scope

| Surface | Status |
|---------|--------|
| Model+thinking presets | Not in this package — see the separate **amp-modes** package for named presets (rush/smart/deep) and the border badge. |
| `-mode` / `-model` flags | Supported on `/handoff` and the `handoff` tool. `subagent` / `/btw` run on the current model (no per-call override). |
| Custom subagent tool sets | Not supported — mirrors the active built-in tools only. |
| Session-query (querying parent sessions) | Included: `session_query` tool + `session-query` skill. |

## Restore / disable

Remove the symlink or the `extensions` entry, then `/reload`.
