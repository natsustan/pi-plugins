/**
 * /btw — run a single-shot subagent in the background while you keep working.
 *
 *   /btw check if there are any TODO comments in src/
 *
 * Fires off an in-process subagent (same runSubagent() as the subagent tool)
 * and shows live progress in a widget above the editor. When done, the widget
 * is replaced by a fully rendered custom message in the chat. The message is
 * filtered out of LLM context (user-facing only), so it doesn't consume the
 * main context window.
 *
 * Unlike the subagent tool, /btw seeds the subagent with the current
 * conversation context (serialized), so it can answer questions about what
 * you've been doing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	formatToolCall,
	formatUsage,
	extractSessionMessages,
	prepareSubagentRunContext,
	runSubagent,
	type SingleResult,
} from "./subagent.ts";

const BTW_MESSAGE_TYPE = "btw-result";
const MINIBOX_LINES = 10;

interface BtwDetails {
	task: string;
	result: SingleResult;
}

let btwCounter = 0;

/** First-line preview of the task, for widget headers. */
function taskPreview(task: string): string {
	const firstLine = task.split("\n")[0] ?? "";
	const maxLen = (process.stdout.columns ?? 120) - "⏳ btw: ".length - 3;
	const trimmed = firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}...` : firstLine;
	return trimmed;
}

/** Plain-text progress lines for setWidget(string[]). */
function progressLines(task: string, r: SingleResult): string[] {
	const lines: string[] = [`⏳ btw: ${taskPreview(task)}`];
	const items = r.displayItems.slice(-MINIBOX_LINES);
	const skipped = r.displayItems.length - items.length;
	if (skipped > 0) lines.push(`  ... ${skipped} earlier items`);
	for (const item of items) {
		if (item.type === "text") {
			const textLines = item.text.split("\n").filter((l) => l.trim());
			lines.push(`  ${textLines.slice(0, 3).join("\n  ")}`);
		} else {
			switch (item.name) {
				case "bash":
					lines.push(`  $ ${String(item.args.command ?? "...").split("\n")[0]}`);
					break;
				case "read":
					lines.push(`  read ${item.args.file_path ?? item.args.path ?? "..."}`);
					break;
				case "write":
					lines.push(`  write ${item.args.file_path ?? item.args.path ?? "..."}`);
					break;
				case "edit":
					lines.push(`  edit ${item.args.file_path ?? item.args.path ?? "..."}`);
					break;
				default:
					lines.push(`  → ${item.name}`);
			}
		}
	}
	return lines;
}

/** Render a finished btw result as a TUI component (for widget + message). */
function renderBtwResult(r: SingleResult, theme: Theme): Box {
	const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));

	box.addChild(
		new Text(`${icon} ${theme.fg("toolTitle", theme.bold("btw: "))}${theme.fg("dim", r.task)}`, 0, 0),
	);

	if (r.exitCode > 0 && r.errorMessage) {
		box.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	for (const item of r.displayItems) {
		if (item.type === "toolCall") {
			box.addChild(
				new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
			);
		}
	}

	if (r.finalOutput) {
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(r.finalOutput.trim(), 0, 0, getMarkdownTheme()));
	}

	const usageStr = formatUsage(r.usage, r.model);
	if (usageStr) box.addChild(new Text(theme.fg("dim", usageStr), 0, 0));

	return box;
}

export default function (pi: ExtensionAPI) {
	// Widgets waiting for turn_end to remove themselves. When the agent is busy,
	// the custom message won't render until the turn boundary, so we show the
	// full rendered result as a widget meanwhile and drop it at turn_end.
	const pendingRemovals = new Map<string, () => void>();
	const activeRuns = new Map<string, AbortController>();

	pi.on("turn_end", () => {
		for (const [, resolve] of pendingRemovals) resolve();
		pendingRemovals.clear();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		for (const [key, controller] of activeRuns) {
			controller.abort();
			ctx.ui.setWidget(key, undefined);
		}
		activeRuns.clear();
		for (const [, resolve] of pendingRemovals) resolve();
		pendingRemovals.clear();
	});

	// Filter btw messages out of LLM context — they are user-facing only.
	pi.on("context", (event) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === BTW_MESSAGE_TYPE),
		);
		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
	});

	// Custom message renderer: always shows the full markdown result.
	pi.registerMessageRenderer<BtwDetails>(BTW_MESSAGE_TYPE, (message, _opts, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;
		return renderBtwResult(details.result, theme);
	});

	pi.registerCommand("btw", {
		description: "Run a single-shot subagent in the background",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /btw <prompt>", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}

			const runContext = prepareSubagentRunContext(pi, ctx);
			if (!runContext) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}

			// Seed the subagent with the current conversation so it can answer
			// questions about what you've been working on.
			const messages = extractSessionMessages(ctx);
			const conversationContext = messages.length > 0
				? serializeConversation(convertToLlm(messages))
				: "";
			const taskWithContext = conversationContext
				? `## Conversation Context\n\n${conversationContext}\n\n## Task or question (FOCUS SOLELY ON THIS)\n\n${task}`
				: task;

			const widgetKey = `btw-${++btwCounter}`;
			const controller = new AbortController();
			activeRuns.set(widgetKey, controller);
			ctx.ui.setWidget(widgetKey, [`⏳ btw: ${taskPreview(task)}`], { placement: "aboveEditor" });

			// Fire and forget — runs in background, updates widget on progress.
			runSubagent({
				systemPrompt: runContext.systemPrompt,
				task: taskWithContext,
				tools: runContext.tools,
				model: runContext.targetModel,
				thinkingLevel: runContext.thinkingLevel,
				apiKeyResolver: runContext.apiKeyResolver,
				signal: controller.signal,
				onProgress: (r) => {
					if (!activeRuns.has(widgetKey)) return;
					ctx.ui.setWidget(widgetKey, progressLines(task, r), { placement: "aboveEditor" });
				},
			}).then(async (result) => {
				if (!activeRuns.has(widgetKey)) return;
				activeRuns.delete(widgetKey);

				// Report under the short user prompt, not the context-enriched one.
				result.task = task;

				const icon = result.exitCode === 0 ? "✓" : "✗";
				pi.sendMessage<BtwDetails>(
					{
						customType: BTW_MESSAGE_TYPE,
						content: [{ type: "text", text: `[btw ${icon}] ${task}` }],
						display: true,
						details: { task, result },
					},
					{ triggerTurn: false },
				);

				// If the agent is busy, the custom message renders only at the
				// turn boundary. Show the full result as a widget meanwhile.
				if (!ctx.isIdle()) {
					ctx.ui.setWidget(widgetKey, (_tui, theme) => renderBtwResult(result, theme), {
						placement: "aboveEditor",
					});
					await new Promise<void>((resolve) => {
						pendingRemovals.set(widgetKey, resolve);
					});
				}
				ctx.ui.setWidget(widgetKey, undefined);
			}).catch((err) => {
				activeRuns.delete(widgetKey);
				ctx.ui.setWidget(widgetKey, undefined);
				ctx.ui.notify(`btw failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});

			// Command returns immediately — subagent runs in background.
		},
	});
}
