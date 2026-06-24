# amp-modes

[pi](https://github.com/earendil-works/pi-mono) extension: named
**model + thinking level presets** for pi — switch both in one step
(`rush` / `smart` / `deep` by default).

Split out of `amp-flow` so the workflow extensions (handoff / subagent / btw)
and the mode manager can be installed and versioned independently.

```
/mode              # picker
/mode rush         # switch directly
/mode store fast   # save current selection into a mode
/mode configure    # add / rename / delete / edit modes
pi --mode deep     # start pi in a named prompt mode
pi --prompt-mode deep  # explicit non-overloaded spelling
Ctrl+Shift+S       # open picker
Ctrl+S             # cycle deep -> rush -> smart
Option+D           # in deep mode: deep -> deep² -> deep³
```

Bootstrap modes (written to `~/.pi/agent/modes.json` on first use; edit there
or in `.pi/modes.json` per project) are model-agnostic by default:

```json
{
  "rush":  { "thinkingLevel": "off" },
  "smart": { "thinkingLevel": "high" },
  "deep":  { "thinkingLevel": "medium" }
}
```

Add `provider` and `modelId` to any mode if you want that mode to switch models
as well as thinking level.

## CLI startup mode

With this extension loaded, you can start directly in a named prompt mode:

```bash
pi --mode deep
pi --mode smart -p "summarize this repo"
```

pi core still owns `--mode json` / `--mode rpc` for output modes; amp-modes only
claims non-core values that match your `modes.json` names. If you prefer not to
overload pi's built-in `--mode`, use the explicit extension flag instead:

```bash
pi --prompt-mode deep
# or
pi --amp-mode deep
```

The active mode is reverse-matched from your current model + thinking whenever
they change (Ctrl+P, `/model`, other extensions), so the label stays accurate.
When nothing matches, no mode is active ("custom").

While the default `deep` mode is active, `Option+D` cycles only its thinking
level: `medium` (`deep`) → `high` (`deep²`) → `xhigh` (`deep³`). `smart` and
`rush` keep their fixed presets.

## Thinking lock while a mode is active

A mode is a fixed **model + thinking** preset, so by default `Shift+Tab`
(`app.thinking.cycle`) is **disabled** while a named mode is active: any thinking
change that diverges from the mode's preset is snapped back, with a notice like
`Thinking locked to "smart" (high) — switch via /mode`.

Why not just rebind the key? `app.thinking.cycle` is one of pi's *reserved*
keybindings — extensions can't override it — so the lock is enforced in the
`thinking_level_select` event handler instead. It only locks when:

- a **named** mode is active (not "custom"),
- that mode pins a `thinkingLevel`, and
- the underlying model hasn't changed (a `Ctrl+P` model switch still drops to
  "custom" as usual).

Toggle it in `/mode configure` → *Lock thinking to active mode: on/off*, or set
`"lockThinkingWhenModeActive": false` in `modes.json`:

```json
{
  "currentMode": "smart",
  "lockThinkingWhenModeActive": false,
  "modes": { ... }
}
```

## Integration with amp-editor

This package does **not** draw editor chrome itself. It publishes the active
mode to a process-global mailbox; the **amp-editor** package reads it and
renders a colored badge in the top-right of the top border. When a mode is
active, the badge *replaces* the model name + thinking level (a mode is already
a model+thinking preset); when no mode matches ("custom"), amp-editor falls back
to showing the model name + level. Load both for the visual label.

The mailbox key (`Symbol.for("amp.modes.current")`) and the change-event channel
(`"amp:modes-change"`) are a **cross-package contract** defined in both
`amp-modes/index.ts` and `amp-editor/index.ts` — no import between the packages,
the literals just have to match. Rename in one, rename in the other.

Setting `"modes": {}` in the config file disables the overlay (labels +
shortcuts) while keeping `/mode configure`.

## Install

### 1. Link into pi's auto-discovered extensions dir

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /Users/spike/projects/pi-plugins/amp-modes ~/.pi/agent/extensions/amp-modes
```

### 2. Reload

Run `/reload` in pi (or restart). `/mode`, the shortcuts, and (with amp-editor)
the border badge appear. No runtime dependencies beyond pi itself.

## Restore / disable

Remove the symlink or the `extensions` entry, then `/reload`.
