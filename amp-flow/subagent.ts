/**
 * subagent tool — run isolated in-process subagents with built-in tools.
 *
 * Also exports runSubagent() and rendering helpers, reused by btw.ts.
 *
 * A subagent gets a fresh context (no conversation history), the 4 built-in
 * tools (read/bash/edit/write), and the main agent's system prompt. It runs
 * to completion via agentLoop() and returns a text summary.
 *
 * Multiple tasks fan out with bounded concurrency (MAX_CONCURRENCY).
 */
import {
	agentLoop,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface SingleResult {
	task: string;
	/** -1 = running, 0 = ok, >0 = error */
	exitCode: number;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface SubagentDetails {
	results: SingleResult[];
}

// ---------------------------------------------------------------------------
// Usage + formatting helpers (shared with btw.ts)
// ---------------------------------------------------------------------------

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			let cmd = (args.command as string) || "...";
			cmd = cmd.replaceAll(homedir(), "~");
			return fg("muted", "$ ") + fg("toolOutput", cmd.split("\n")[0]!);
		}
		case "read": {
			const path = shortenPath(((args.file_path ?? args.path) as string) || "...");
			return fg("muted", "read ") + fg("accent", path);
		}
		case "write": {
			const path = shortenPath(((args.file_path ?? args.path) as string) || "...");
			return fg("muted", "write ") + fg("accent", path);
		}
		case "edit": {
			const path = shortenPath(((args.file_path ?? args.path) as string) || "...");
			return fg("muted", "edit ") + fg("accent", path);
		}
		default: {
			const s = JSON.stringify(args);
			const preview = s.length > 50 ? `${s.slice(0, 50)}...` : s;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Core: run a single subagent loop
// ---------------------------------------------------------------------------

export interface RunSubagentOptions {
	systemPrompt: string;
	task: string;
	tools: AgentTool<any>[];
	model: Model<any>;
	thinkingLevel: string;
	apiKeyResolver: (provider: string) => Promise<string | undefined> | string | undefined;
	signal?: AbortSignal;
	onProgress?: (result: SingleResult) => void;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<SingleResult> {
	const result: SingleResult = {
		task: opts.task,
		exitCode: -1,
		displayItems: [],
		finalOutput: "",
		usage: emptyUsage(),
		model: `${opts.model.provider}/${opts.model.id}`,
	};

	const userMessage: AgentMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					"You are operating as a subagent within a larger agent session.",
					"Complete the following task thoroughly, then provide your final response as text.",
					"Be concise and focused. Do NOT hand off or spawn further subagents.",
					"",
					opts.task,
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	const context: AgentContext = {
		systemPrompt: opts.systemPrompt,
		messages: [],
		tools: opts.tools,
	};

	const config: AgentLoopConfig = {
		model: opts.model,
		convertToLlm,
		getApiKey: opts.apiKeyResolver,
		reasoning: opts.thinkingLevel !== "off" ? (opts.thinkingLevel as any) : undefined,
	};

	try {
		const stream = agentLoop([userMessage], context, config, opts.signal);

		for await (const event of stream) {
			if (opts.signal?.aborted) break;

			if (event.type === "message_end") {
				const msg = event.message as any;
				if (msg.role === "assistant") {
					result.usage.turns++;
					const u = msg.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						result.usage.contextTokens = u.totalTokens || 0;
					}
					if (msg.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;

					for (const part of msg.content as any[]) {
						if (part.type === "text") {
							result.displayItems.push({ type: "text", text: part.text });
							result.finalOutput = part.text;
						} else if (part.type === "toolCall") {
							result.displayItems.push({
								type: "toolCall",
								name: part.name,
								args: part.arguments,
							});
						}
					}
					opts.onProgress?.(result);
				}
			} else if (event.type === "tool_execution_end") {
				opts.onProgress?.(result);
			}
		}

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			result.exitCode = 1;
		} else if (result.exitCode === -1) {
			result.exitCode = 0;
		}
	} catch (err) {
		result.exitCode = 1;
		result.errorMessage = err instanceof Error ? err.message : String(err);
		if (opts.signal?.aborted) result.stopReason = "aborted";
	}

	return result;
}

// ---------------------------------------------------------------------------
// Parallel execution helper
// ---------------------------------------------------------------------------

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current]!, current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Rendering: collapsed minibox + expanded list
// ---------------------------------------------------------------------------

const MINIBOX_LINES = 10;

function renderMinibox(r: SingleResult, expanded: boolean, theme: Theme): string {
	const isRunning = r.exitCode === -1;
	const isError = r.exitCode > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: isError
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const lines: string[] = [`${icon} ${theme.fg("dim", r.task)}`];

	if (isError && r.errorMessage) {
		lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	}

	const items = r.displayItems;
	const itemsToShow = expanded ? items : items.slice(-MINIBOX_LINES);
	const skipped = items.length - itemsToShow.length;
	if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier items`));

	for (const item of itemsToShow) {
		if (item.type === "text") {
			if (expanded) continue;
			const textLines = item.text.split("\n").filter((l) => l.trim());
			const preview = textLines.slice(0, 5).join("\n");
			lines.push(theme.fg("toolOutput", preview));
			if (textLines.length > 5) lines.push(theme.fg("muted", `... +${textLines.length - 5} lines`));
		} else {
			lines.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}

	if (!isRunning) {
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) lines.push(theme.fg("dim", usageStr));
	}

	return lines.join("\n");
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/**
 * Render a list of results as a TUI component (collapsed or expanded).
 * Used by the subagent tool's renderResult.
 */
export function renderResults(
	results: SingleResult[],
	options: { expanded: boolean; label: string },
	theme: Theme,
): Component {
	const mdTheme = getMarkdownTheme();

	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const failCount = results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: results.length === 1
			? ""
			: `${successCount}/${results.length} tasks`;

	// Expanded view (only when finished)
	if (options.expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`,
				0, 0,
			),
		);
		for (const r of results) {
			const rIcon = r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
			container.addChild(new Spacer(1));
			container.addChild(new Text(`${theme.fg("muted", "─── ")}${rIcon} ${theme.fg("dim", r.task)}`, 0, 0));
			if (r.exitCode > 0 && r.errorMessage) {
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			}
			for (const item of r.displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0, 0,
						),
					);
				}
			}
			if (r.finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
			}
			const usageStr = formatUsage(r.usage, r.model);
			if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		if (results.length > 1) {
			const totalStr = formatUsage(aggregateUsage(results));
			if (totalStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
			}
		}
		return container;
	}

	// Collapsed / running view
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`;
	for (const r of results) {
		text += `\n\n${renderMinibox(r, options.expanded, theme)}`;
	}
	if (!isRunning && results.length > 1) {
		const totalStr = formatUsage(aggregateUsage(results));
		if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
	}
	if (!options.expanded && !isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 4;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Run isolated subagents with built-in tools (read, write, edit, bash).",
			"Subagents have two benefits - quickly perform parallel tasks, and save space in your context window.",
			"Subagents are suitable for independent, well-defined, context-hungry, short-output subtasks that don't need back-and-forth with the user, such as research or refactoring.",
			"The downside is they are non-interactive for the user and output tokens are expensive; therefore, use them ONLY when explicitly asked or when your verbalized thinking confirms MAJOR benefits in the current situation).",
			"(Example of a prompt you should NOT use a subagent for: 'run A B C D and provide all file contents and command outputs')",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(Type.String(), {
				description: "Task prompts for subagents (one subagent per task is spawned). A subagent has no conversation history — include all relevant context (file paths, decisions, requirements) and the exact task description in this prompt.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const tasks = params.tasks as string[];
			if (!tasks || tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Provide at least one task." }],
					details: { results: [] } as SubagentDetails,
				};
			}

			if (!ctx.model) {
				return {
					content: [{ type: "text", text: "No model available." }],
					details: { results: [] } as SubagentDetails,
				};
			}

			const targetModel = ctx.model;
			const thinkingLevel = pi.getThinkingLevel();

			// Fresh built-in tools scoped to the current cwd.
			const tools: AgentTool<any>[] = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
			];

			const systemPrompt = ctx.getSystemPrompt();
			const apiKeyResolver = async (_provider: string) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(targetModel);
				return auth.ok ? auth.apiKey : undefined;
			};

			const allResults: SingleResult[] = tasks.map((task) => ({
				task,
				exitCode: -1,
				displayItems: [],
				finalOutput: "",
				usage: emptyUsage(),
			}));

			const emitUpdate = () => {
				if (!onUpdate) return;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				const running = allResults.length - done;
				const statusText = allResults.length === 1
					? (allResults[0]!.finalOutput || "(running...)")
					: `${done}/${allResults.length} done, ${running} running...`;
				onUpdate({
					content: [{ type: "text", text: statusText }],
					details: { results: [...allResults] } as SubagentDetails,
				});
			};

			// Emit immediately so the result block renders from the start.
			emitUpdate();

			const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (task, index) => {
				const result = await runSubagent({
					systemPrompt,
					task,
					tools,
					model: targetModel,
					thinkingLevel,
					apiKeyResolver,
					signal,
					onProgress: (r) => {
						allResults[index] = r;
						emitUpdate();
					},
				});
				allResults[index] = result;
				emitUpdate();
				return result;
			});

			const successCount = results.filter((r) => r.exitCode === 0).length;
			const failCount = results.length - successCount;
			const summaries = results.map(
				(r) => `[${r.exitCode === 0 ? "✓" : "✗"}] ${r.finalOutput || "(no output)"}`,
			);
			const isError = results.length === 1
				? results[0]!.exitCode !== 0
				: failCount === results.length;

			return {
				content: [
					{ type: "text", text: `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` },
				],
				details: { results } as SubagentDetails,
				isError,
			};
		},

		// renderCall omitted: we emit an initial onUpdate immediately so the
		// result block renders from the start (avoids duplicating the task).

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			return renderResults(details.results, { expanded, label: "subagent" }, theme);
		},
	});
}
