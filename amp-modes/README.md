# amp-modes

[pi](https://github.com/earendil-works/pi-mono) extension: named
**model + thinking level (+ color) presets** for pi — switch all three in one
step (`rush` / `smart` / `deep` by default).

Split out of `amp-flow` so the workflow extensions (handoff / subagent / btw)
and the mode manager can be installed and versioned independently.

```
/mode              # picker
/mode rush         # switch directly
/mode store fast   # save current selection into a mode
/mode configure    # add / rename / delete / edit modes
Ctrl+Shift+S       # open picker
Ctrl+S             # cycle deep → rush → smart → …
```

Bootstrap modes (written to `~/.pi/agent/modes.json` on first use; edit there
or in `.pi/modes.json` per project):

```json
{
  "rush":  { "provider": "openai-codex", "modelId": "gpt-5.5", "thinkingLevel": "off" },
  "smart": { "provider": "zai", "modelId": "glm-5.2", "thinkingLevel": "high" },
  "deep":  { "provider": "openai-codex", "modelId": "gpt-5.5", "thinkingLevel": "medium" }
}
```

The active mode is reverse-matched from your current model + thinking whenever
they change (Ctrl+P, `/model`, other extensions), so the label stays accurate.
When nothing matches, no mode is active ("custom").

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
