# Amp Editor

A [pi](https://github.com/earendil-works/pi-mono) extension that restyles pi's
prompt panel into a **bottom-docked ASCII frame inspired by Amp Code**:
rounded box, model name docked to the top-right, `cwd (git-branch) · ctx %`
docked to the bottom-right, and a braille spinner on the top-left while the
agent runs.

```
╭ ⠋────────────────────────── smart ───────────────────╮
│ █                                                    │
│                                                      │
╰────────── ~/projects/pi-plugins (main) · 12% ────╯
```

When the **amp-flow** modes extension is loaded alongside this one and a named
mode is active, its name is shown as a colored badge (` smart ` above) docked
top-right, replacing the model name + thinking level — a mode is itself a
model+thinking preset, so showing both would be redundant. The badge uses the
mode's configured color, or the thinking-level color when the mode has none.
When the current selection doesn't match any mode ("custom"), the badge is
hidden and the model name + thinking level are shown instead, so the top-right
is never blank. The two packages communicate via a process-global mailbox +
event — no import needed, just load both.

The box frame is plain (default fg). The **thinking-level color** (pi's
`EditorTheme.borderColor`, set per active thinking level) highlights the model
name + thinking-level suffix. The bottom-right cluster — **cwd, git branch,
and context %** — is uniformly **muted** (pi's dim text color), matching the
cwd display so the whole cluster reads as one consistent unit. The model name
gains a ` (<level>)` suffix showing the current thinking level — e.g.
suffix showing the current thinking level — e.g. `claude-sonnet-4-5 (high)`
— taken from `pi.getThinkingLevel()`
(`minimal`/`low`/`medium`/`high`/`xhigh`). The suffix is omitted when thinking
is `off`, since pi clamps non-reasoning models to `off` anyway.

## Install

### Option A — symlink into the auto-discovered extensions dir (recommended)

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /Users/spike/projects/pi-plugins/amp-editor \
      ~/.pi/agent/extensions/amp-editor
```

Auto-discovered extensions can be hot-reloaded with `/reload` after edits.

### Option B — register via `settings.json`

Add the path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/spike/projects/pi-plugins/amp-editor"
  ]
}
```

### Quick test without installing

```bash
pi -e /Users/spike/projects/pi-plugins/amp-editor
```

## What it changes

| Surface            | Before                          | After                                                |
| ------------------ | ------------------------------- | ---------------------------------------------------- |
| Editor top border  | plain `──────`                  | `╭ [spinner]───── model (<level>) ╮`                  |
| Editor sides       | none                            | `│ … │` (text inset 1 col from the border)            |
| Editor bottom      | plain `──────`                  | `╰ [↓ N]───── ~/cwd (branch) · % ╯` (muted cluster)  |
| Working indicator  | separate row above editor       | spinner inline in the top-left of the panel          |
| Footer             | model / tokens / cost / cwd row | hidden (the panel now carries model + cwd + context) |

pi's autocomplete dropdown (`/` commands, `@` files, path completion) still
works — it renders below the box, aligned to the content column. Scroll
overflow indicators (`↑ N more` / `↓ N more`) are preserved and re-embedded on
the left of the respective border.

## Restoring defaults

The extension hides pi's default working-indicator row and footer because the
panel now shows that information. To bring either back, drop a tiny shim
extension loaded **after** this one:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setFooter(undefined); // restore built-in footer
  });
}
```

## How it works

`AmpEditor` extends `CustomEditor` (so all app keybindings — escape to abort,
ctrl+d, model switching, etc. — keep working). On each render it:

1. Calls `super.render(width - 2)` to let the base editor lay out text,
   cursor, and autocomplete inside the inner width.
2. Finds the base's bottom border — the highest-indexed border-shaped line
   (`/^─*( [↑↓] \d+ more )?─*$/` after ANSI stripping), since autocomplete
   lines that follow never match.
3. Replaces the top and bottom border lines with rounded, labeled borders.
4. Wraps each content line in `│ … │`.
5. Passes autocomplete lines through below the box, aligned with one leading
   space and padded to the full width.

The base editor's `CURSOR_MARKER` is preserved verbatim inside the wrapped
line, so IME candidate-window positioning and the fake cursor keep working.

## Tunables

At the top of `index.ts`:

```ts
/** Columns of inset between the left │ border and where text/cursor starts. */
const PADDING_X = 1;

const CORNERS = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", side: "│", dash: "─" };
const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const SPINNER_INTERVAL_MS = 80;
```

Prefer square corners? Swap `╭╮╰╯` for `┌┐└┘`.

## Scope

TUI-only. In RPC / JSON / print modes the `session_start` handler returns early
(`ctx.mode !== "tui"`), so the chrome is not applied and built-in behavior is
untouched.
