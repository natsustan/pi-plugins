---
name: session-query
description: Query previous pi sessions to retrieve context, decisions, code changes, or other information. Use when you need to look up what happened in a parent session (referenced in a handoff prompt) or any other session file.
---

# Session Query

Query pi session files to retrieve context from past conversations.

This is most useful in handed-off sessions, where the opening prompt includes a
**Parent session** path and usually a **Parent session leaf** id. Use this tool
to look up details from that exact parent branch instead of guessing or asking
the user.

## Usage

Use the `session_query` tool:

```
session_query(sessionPath, question, leafId?)
```

- `sessionPath` — full path to the session `.jsonl` file. In a handed-off
  session this is the **Parent session** path shown at the top of the prompt.
- `leafId` — optional stable leaf id. In a handed-off session this is the
  **Parent session leaf** value; include it when present so the query uses the
  branch that produced the handoff, not whatever the parent session later became.
- `question` — a specific question about that session (e.g. "What files were
  modified?", "What approach was chosen?", "Summarize the key decisions").

## Examples

```
session_query("/path/to/session.jsonl", "What files were modified?")
session_query("/path/to/session.jsonl", "What files were modified?", "entry-id-from-handoff")
session_query("/path/to/session.jsonl", "What approach was chosen for authentication?")
session_query("/path/to/session.jsonl", "Summarize the key decisions made")
```

The tool loads the session and uses an LLM (the queried session's own model) to
answer your question based on its contents. Ask specific questions for best
results; if the information isn't in the session, the tool will say so.
