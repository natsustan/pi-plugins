/**
 * Amp Editor — restyles pi's prompt panel into a bottom-docked ASCII frame
 * inspired by Amp Code: rounded corners, model name docked to the top-right,
 * cwd + git branch + context % docked to the bottom-right, a braille spinner
 * on the top-left while the agent is running.
 *
 * Load it and it takes over the editor chrome. The default working-indicator
 * row and footer are hidden because the panel now carries that information.
 *
 *   pi -e /Users/spike/projects/pi-plugins/amp-editor
 *
 * Layout:
 *
 *   ╭ ⠋─────────────────────────────────── claude-sonnet-4-5 ╮
 *   │ █                                                    │
 *   │                                                      │
 *   ╰────────── ~/projects/pi-plugins (main) · 12% ────╯
 *
 * The border color still reflects the active thinking level (pi's built-in
 * behavior via EditorTheme.borderColor), so thinking is communicated without
 * extra text.
 *
 * The base editor is rendered at `width - 2` and its content lines are then
 * wrapped in `│ … │`. The top/bottom border lines from the base are replaced
 * entirely; their scroll indicators (`─── ↑ N more ───`) are parsed and
 * re-embedded on the left of the respective border so long prompts still show
 * overflow. The base editor's CURSOR_MARKER is preserved verbatim inside the
 * wrapped line, so IME candidate-window positioning and the fake cursor keep
 * working.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
/** Strip SGR/CSI escape sequences for content-based pattern matching. */
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

// ---- tunables -------------------------------------------------------------

/**
 * Columns of inset between the left `│` border and where text/cursor
 * starts. The box frame stays flush at column 0; only the input is indented.
 */
const PADDING_X = 1;

/** Box-drawing characters. Swap for `┌┐└┘` if you prefer square corners. */
const CORNERS = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	side: "│",
	dash: "─",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// ---- helpers --------------------------------------------------------------

/**
 * Build a horizontal border line with corners and optional labels docked to
 * the left and right. Labels are truncated (right first, then left) until they
 * fit with at least `minGap` fill dashes between them.
 *
 *   renderBorder("╭","╮", left, right, width, border, fill)
 *   => "╭<left><fill dashes><right>╮"
 */
function renderBorder(
	cornerL: string,
	cornerR: string,
	left: string,
	right: string,
	width: number,
	border: (s: string) => string,
	fill: (s: string) => string = border,
	minGap = 3,
): string {
	const inner = width - visibleWidth(cornerL) - visibleWidth(cornerR);
	if (inner <= 0) return border(cornerL + cornerR);

	let l = left;
	let r = right;

	while (visibleWidth(l) + visibleWidth(r) + minGap > inner && visibleWidth(r) > 0) {
		r = truncateToWidth(r, Math.max(0, visibleWidth(r) - 1), "");
	}
	while (visibleWidth(l) + visibleWidth(r) + minGap > inner && visibleWidth(l) > 0) {
		l = truncateToWidth(l, Math.max(0, visibleWidth(l) - 1), "");
	}

	const gap = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
	return border(cornerL) + l + fill(CORNERS.dash.repeat(gap)) + r + border(cornerR);
}

/** `~/projects/x` for display, collapsing $HOME. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/** ` · 12%` when usage is known and non-zero, else empty (nothing to show at 0%). */
function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!window || !usage || usage.percent == null) return "";
	const pct = Math.round(usage.percent);
	return pct > 0 ? ` · ${pct}%` : "";
}

/**
 * The base editor renders overflow borders as themed strings like
 * `─── ↑ 3 more ───`. Pull the count back out so we can re-embed it in our
 * custom border. Safe to run on ANSI-laden strings: the regex anchors on the
 * literal arrow + " more " around the digits.
 */
function matchScroll(line: string | undefined, arrow: "↑" | "↓"): number | null {
	if (!line) return null;
	const m = line.match(new RegExp(`${arrow} (\\d+) more`));
	return m ? Number(m[1]!) : null;
}

/**
 * A base-editor border line (top or bottom) is, after ANSI stripping, either
 * a full run of `─` or a scroll indicator `─── ↓ N more ───`. Content and
 * autocomplete lines never look like this, so this identifies border lines.
 */
const BORDER_LINE_RE = /^─*( (?:↑|↓) \d+ more )?─*$/;
const isBorderLine = (line: string): boolean => BORDER_LINE_RE.test(stripAnsi(line));

/** A component that renders nothing — used to blank out the default footer. */
class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

// ---- extension ------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let branch: string | undefined;
	let branchTimer: ReturnType<typeof setInterval> | undefined;

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	const refreshBranch = async (ctx: ExtensionContext) => {
		const result = await pi
			.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd })
			.catch(() => undefined);
		const stdout = result?.stdout.trim();
		branch = stdout && stdout.length > 0 ? stdout : undefined;
		activeTui?.requestRender();
	};

	pi.on("agent_start", () => {
		isWorking = true;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			activeTui?.requestRender();
		}, SPINNER_INTERVAL_MS);
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	// Re-render when things shown in the border change.
	pi.on("model_select", () => activeTui?.requestRender());
	pi.on("thinking_level_select", () => activeTui?.requestRender());
	pi.on("turn_end", () => activeTui?.requestRender()); // context % updates

	pi.on("session_shutdown", () => {
		stopSpinner();
		if (branchTimer) {
			clearInterval(branchTimer);
			branchTimer = undefined;
		}
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return; // panel chrome is TUI-only

		// The panel is now the sole status surface.
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyComponent());

		void refreshBranch(ctx);
		// Cheap periodic branch refresh (covers checkouts done outside pi).
		branchTimer = setInterval(() => void refreshBranch(ctx), 10_000);

		class AmpEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: PADDING_X });
				activeTui = tui;
			}

			render(width: number): string[] {
				// Reserve 2 columns for the side borders, let the base editor lay
				// out text + cursor + autocomplete inside that.
				const inner = Math.max(1, width - 2);
				const base = super.render(inner);
				if (base.length === 0) return base;
				if (base.length === 1) {
					// Degenerate frame: just seal the single line top and bottom (plain chrome).
					const frame = (s: string) => s;
					return [
						renderBorder(CORNERS.topLeft, CORNERS.topRight, "", "", width, frame),
						renderBorder(CORNERS.bottomLeft, CORNERS.bottomRight, "", "", width, frame),
					];
				}

				const th = ctx.ui.theme;
				// Color scheme: the thinking-level color (this.borderColor, set by pi
				// from the active thinking level) highlights "live" info — model name,
				// thinking level, git branch, context %. The box frame and cwd path use
				// plain (default) text color, like the model name used to.
				const thinkingFg = (s: string) => this.borderColor(s);
				const frame = (s: string) => s;
				const side = frame(CORNERS.side);

				// The base returns [topBorder, ...content, bottomBorder, ...autocomplete].
				// Autocomplete (when active) renders BELOW the bottom border, so find
				// the real bottom border = the highest-indexed border-shaped line
				// (autocomplete lines after it never match). Falls back to the last
				// line when nothing matches.
				let bottomIdx = base.length - 1;
				for (let i = base.length - 1; i >= 1; i--) {
					if (isBorderLine(base[i]!)) {
						bottomIdx = i;
						break;
					}
				}

				const topScroll = matchScroll(base[0], "↑");
				const bottomScroll = matchScroll(base[bottomIdx], "↓");

				const out: string[] = [];

				// --- top border: spinner (or scroll-up) on the left, model on the right
				let topLeft: string;
				if (isWorking) {
					topLeft = th.fg("accent", ` ${SPINNER_FRAMES[spinnerIndex]!} `);
				} else if (topScroll != null) {
					topLeft = th.fg("muted", ` ↑ ${topScroll} `);
				} else {
					topLeft = "";
				}
				// Show the active thinking level (high/medium/…) in parens after the
				// model name. pi clamps non-reasoning models to "off", so when it's
				// "off" we omit the suffix entirely. Both model name and level use the
				// thinking-level color.
				const level = pi.getThinkingLevel();
				const thinkingSuffix = level !== "off" ? ` (${level})` : "";
				const modelText = ctx.model ? ` ${ctx.model.id}${thinkingSuffix} ` : "";
				const model = modelText ? thinkingFg(modelText) + frame(CORNERS.dash) : "";
				out.push(renderBorder(CORNERS.topLeft, CORNERS.topRight, topLeft, model, width, frame));

				// --- content lines wrapped in │ … │
				// The base pads each line to `inner` visible width, so wrapping
				// yields exactly `width`. CURSOR_MARKER stays in place → IME ok.
				for (let i = 1; i < bottomIdx; i++) {
					out.push(side + base[i]! + side);
				}

				// --- bottom border: scroll-down on the left, cwd(branch)·ctx on the right.
				// cwd stays plain; git branch and context % take the thinking-level color.
				const bottomLeft = bottomScroll != null ? th.fg("muted", ` ↓ ${bottomScroll} `) : "";
				// cwd one step dimmer than plain text (matches the scroll indicator),
				// so it recedes behind the thinking-colored branch + ctx %.
				const cwdPart = th.fg("muted", formatCwd(ctx.cwd));
				const branchPart = branch ? thinkingFg(` (${branch})`) : "";
				const ctxPart = formatContext(ctx);
				const ctxColored = ctxPart ? thinkingFg(ctxPart) : "";
				const bottomRight = ` ${cwdPart}${branchPart}${ctxColored} ` + frame(CORNERS.dash);
				out.push(
					renderBorder(CORNERS.bottomLeft, CORNERS.bottomRight, bottomLeft, bottomRight, width, frame),
				);

				// --- autocomplete (if active): rendered below the box, aligned to the
				// content column (one leading space) and padded out to `width`.
				for (let i = bottomIdx + 1; i < base.length; i++) {
					const line = base[i]!;
					const vw = visibleWidth(line);
					const pad = " ".repeat(Math.max(0, width - 1 - vw));
					out.push(" " + line + pad);
				}

				return out;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new AmpEditor(tui, theme, keybindings));
	});
}
