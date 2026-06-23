/**
 * handoff — transfer context to a new focused session.
 *
 * Two entry points:
 *   /handoff [-mode <name>] [-model <provider/id>] <goal>
 *                                      — command path (ExtensionCommandContext).
 *                                        Uses ctx.newSession() for a clean
 *                                        session replacement. The new session's
 *                                        session_start handler applies the
 *                                        prompt + model options (the old `pi`
 *                                        is stale after replacement, so we
 *                                        stash via globalThis).
 *   handoff tool (mode/model params)   — agent-callable (ExtensionContext, no
 *                                        newSession). Stashes the prompt and
 *                                        switches via the low-level
 *                                        sessionManager in the agent_end
 *                                        handler (the same `pi` stays alive,
 *                                        so the current model/thinking carry
 *                                        over naturally).
 *
 * Model handling on the new session:
 *   - no flags → restore the CURRENT session's model + thinking (the
 *     command-path replacement would otherwise drop to pi's default model).
 *   - -mode    → apply the named modes.json preset (model + thinking).
 *   - -model   → apply the given provider/modelId (thinking unchanged).
 *
 * The summary is always generated with the CURRENT session's model before
 * switching. amp-modes (if loaded) syncs its active-mode label from the
 * resulting model_select / thinking_level_select events.
 */
import { complete, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractSessionMessages } from "./subagent.ts";
import { loadModeSpec, type HandoffOptions } from "./modes.ts";

const SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained — the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" — just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

// ---------------------------------------------------------------------------
// Cross-session handoff stashing (command path)
// ---------------------------------------------------------------------------
//
// ctx.newSession() replaces the runtime; the old extension instance (and its
// `pi` reference) becomes stale. globalThis survives the replacement, so the
// old instance stashes the prompt + model options + a default-model restore
// here, and the NEW instance's session_start handler picks them up and applies
// them with its fresh `pi`.

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type HandoffSelection = {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

const HANDOFF_GLOBAL_KEY = Symbol.for("amp-flow-handoff-pending");
const AMP_MODES_APPLY_KEY = Symbol.for("amp.modes.apply");
type AmpModesApply = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: string,
) => Promise<boolean | void> | boolean | void;
type PendingHandoffGlobal = {
	prompt: string;
	options?: HandoffOptions;
	restore?: HandoffSelection;
} | null;

function getPendingHandoffGlobal(): PendingHandoffGlobal {
	return (globalThis as any)[HANDOFF_GLOBAL_KEY] ?? null;
}
function setPendingHandoffGlobal(data: PendingHandoffGlobal): void {
	if (data) {
		(globalThis as any)[HANDOFF_GLOBAL_KEY] = data;
	} else {
		delete (globalThis as any)[HANDOFF_GLOBAL_KEY];
	}
}

async function applyModeViaAmpModes(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: string,
): Promise<boolean> {
	const apply = (globalThis as any)[AMP_MODES_APPLY_KEY] as AmpModesApply | undefined;
	if (typeof apply !== "function") return false;
	const result = await apply(pi, ctx, mode);
	return result !== false;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/** Generate a context summary by distilling the conversation toward the goal. */
async function generateContextSummary(
	model: any,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	messages: any[],
	goal: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const conversationText = serializeConversation(convertToLlm(messages));

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, headers, signal },
	);

	if (response.stopReason !== "stop") return null;

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Build the final prompt: goal first, parent session ref, then summary. */
function buildFinalPrompt(
	goal: string,
	summary: string,
	parentSession: string | undefined,
	parentLeafId: string | null,
): string {
	if (parentSession) {
		const leafLine = parentLeafId ? `\n**Parent session leaf:** \`${parentLeafId}\`` : "";
		return `${goal}\n\n**Parent session:** \`${parentSession}\`${leafLine}\n\n${summary}`;
	}
	return `${goal}\n\n${summary}`;
}

// ---------------------------------------------------------------------------
// Model option application
// ---------------------------------------------------------------------------

/**
 * Restore the previous session's model + thinking into the new session.
 * Used on the command path when no -mode/-model is given (newSession() would
 * otherwise reset to pi's default model).
 */
async function restoreHandoffSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	restore: HandoffSelection,
): Promise<void> {
	const model = ctx.modelRegistry.find(restore.provider, restore.modelId);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Handoff: could not restore ${restore.provider}/${restore.modelId}; using current session model`,
				"warning",
			);
		}
	} else {
		const ok = await pi.setModel(model);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(
				`Handoff: no API key for ${restore.provider}/${restore.modelId}; using current session model`,
				"warning",
			);
		}
	}
	pi.setThinkingLevel(restore.thinkingLevel);
}

/**
 * Apply -mode and -model options. For -mode, read the spec from modes.json and
 * apply model+thinking. For -model, apply provider/modelId directly. amp-modes
 * syncs its active-mode label from the resulting model_select event.
 */
async function applyHandoffOptions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: HandoffOptions,
): Promise<void> {
	if (options.mode) {
		const appliedByAmpModes = await applyModeViaAmpModes(pi, ctx, options.mode);
		const spec = appliedByAmpModes ? undefined : loadModeSpec(ctx.cwd, options.mode);
		if (spec) {
			if (spec.provider && spec.modelId) {
				const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
				if (model) {
					// setModel returns false when the model is in the registry
					// but has no usable API key. Apply the mode's thinking level
					// together with the model so a failed switch can't leave the
					// preset half-applied (thinking changed, model unchanged).
					const ok = await pi.setModel(model);
					if (ok) {
						if (spec.thinkingLevel) {
							pi.setThinkingLevel(spec.thinkingLevel as ThinkingLevel);
						}
					} else if (ctx.hasUI) {
						ctx.ui.notify(
							`Handoff: mode "${options.mode}" model ${spec.provider}/${spec.modelId} has no API key; mode not applied`,
							"warning",
						);
					}
				} else if (ctx.hasUI) {
					ctx.ui.notify(
						`Handoff: mode "${options.mode}" references unknown model ${spec.provider}/${spec.modelId}`,
						"warning",
					);
				}
			} else if (spec.thinkingLevel) {
				// Mode has no model component; apply thinking alone.
				pi.setThinkingLevel(spec.thinkingLevel as ThinkingLevel);
			}
		} else if (!appliedByAmpModes && ctx.hasUI) {
			ctx.ui.notify(`Handoff: unknown mode "${options.mode}"`, "warning");
		}
	}

	if (options.model) {
		const slashIdx = options.model.indexOf("/");
		if (slashIdx > 0) {
			const provider = options.model.slice(0, slashIdx);
			const modelId = options.model.slice(slashIdx + 1);
			const model = ctx.modelRegistry.find(provider, modelId);
			if (model) {
				const ok = await pi.setModel(model);
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(
						`Handoff: ${options.model} has no API key; using current model`,
						"warning",
					);
				}
			} else if (ctx.hasUI) {
				ctx.ui.notify(`Handoff: unknown model ${options.model}`, "warning");
			}
		} else if (ctx.hasUI) {
			ctx.ui.notify(
				`Handoff: invalid model format "${options.model}", expected provider/modelId`,
				"warning",
			);
		}
	}
}

/** Parse optional -mode / -model flags out of the /handoff arg string.
 * Only flags at the very start of the string are consumed (in any order), so a
 * literal "-mode" later inside the goal isn't stripped. */
function parseHandoffArgs(args: string): { options: HandoffOptions; goal: string } {
	const options: HandoffOptions = {};
	let remaining = args.trim();
	while (true) {
		const m = remaining.match(/^-(mode|model)\s+(\S+)\s*/);
		if (!m) break;
		if (m[1] === "mode") options.mode = m[2];
		else options.model = m[2];
		remaining = remaining.slice(m[0].length);
	}
	return { options, goal: remaining.trim() };
}

// ---------------------------------------------------------------------------
// Core handoff logic
// ---------------------------------------------------------------------------

/**
 * Command path: stash on globalThis; the new session's session_start handler
 * applies the prompt + options with a fresh `pi` (the old one is stale after
 * newSession()).
 * Tool path: stash for the agent_end handler (same `pi` stays alive; current
 * model/thinking carry over, so only -mode/-model need explicit application).
 */
async function performHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	fromCommand: boolean,
	stashToolPath: (v: { prompt: string; parentSession: string | undefined; options?: HandoffOptions }) => void,
	markCommandHandoff: () => void,
	options?: HandoffOptions,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return "Handoff requires interactive mode.";
	if (!ctx.model) return "No model selected.";

	const messages = extractSessionMessages(ctx);
	if (messages.length === 0) return "No conversation to hand off.";

	const parentSession = ctx.sessionManager.getSessionFile();
	const parentLeafId = ctx.sessionManager.getLeafId();

	// Generate summary with a loader UI (abortable).
	const summary = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done(null);
		(async () => {
			const auth = await ctx.modelRegistry!.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok) {
				done(null);
				return;
			}
			const text = await generateContextSummary(
				ctx.model!,
				auth.apiKey,
				auth.headers,
				messages,
				goal,
				loader.signal,
			);
			done(text);
		})().catch((err) => {
			console.error("Handoff generation failed:", err);
			done(null);
		});
		return loader;
	});

	if (summary == null) return "Handoff cancelled.";

	const finalPrompt = buildFinalPrompt(goal, summary, parentSession, parentLeafId);

	if (fromCommand) {
		// Command path: full runtime replacement via newSession(). The new
		// session's session_start handler picks up the stash and applies it with
		// a fresh `pi`. Always restore the current model + thinking first; then
		// -mode/-model override only the fields they explicitly specify.
		const cmdCtx = ctx as ExtensionCommandContext;
		const hasOptions = !!options?.mode || !!options?.model;
		const restore: HandoffSelection | undefined =
			ctx.model
				? {
					provider: ctx.model.provider,
					modelId: ctx.model.id,
					thinkingLevel: pi.getThinkingLevel(),
				}
				: undefined;
		setPendingHandoffGlobal({ prompt: finalPrompt, options: hasOptions ? options : undefined, restore });
		markCommandHandoff();
		try {
			const result = await cmdCtx.newSession({ parentSession });
			if (result.cancelled) {
				setPendingHandoffGlobal(null);
			}
		} catch (err) {
			setPendingHandoffGlobal(null);
			throw err;
		}
	} else {
		// Tool path: stash for the agent_end handler. The runtime is NOT
		// replaced, so the current model + thinking carry over; only -mode /
		// -model need explicit application there.
		const hasOptions = !!options?.mode || !!options?.model;
		stashToolPath({ prompt: finalPrompt, parentSession, options: hasOptions ? options : undefined });
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Tool-path coordination state.
	let pending: { prompt: string; parentSession: string | undefined; options?: HandoffOptions } | null = null;
	// Timestamp marking the tool-path session switch; used by the context
	// handler to filter out pre-handoff messages that linger in agent state.
	let handoffTimestamp: number | null = null;
	// True between stashing a command-path handoff and the resulting
	// session_shutdown. Lets that shutdown preserve the stash for the fresh
	// instance's session_start instead of clearing it as a leaked stash.
	let commandHandoffPending = false;

	// After the agent loop ends, perform the deferred tool-path switch.
	pi.on("agent_end", (_event, ctx) => {
		if (!pending) return;
		const { prompt, parentSession, options } = pending;
		pending = null;

		// Record timestamp BEFORE switching — old messages precede it.
		handoffTimestamp = Date.now();

		// Low-level switch: creates a new session file. This does NOT replace
		// the runtime or clear agent.state.messages (we handle that via the
		// context event below). ReadonlySessionManager hides this method at
		// the type level, but it exists at runtime.
		(ctx.sessionManager as any).newSession({ parentSession });

		// Defer to the next macrotask so the old agent loop's cleanup completes
		// before we start a new turn. Apply -mode/-model first (the runtime
		// isn't replaced, so without flags the current model already carries
		// over and there's nothing to do).
		setTimeout(async () => {
			if (options?.mode || options?.model) {
				await applyHandoffOptions(pi, ctx, options);
			}
			pi.sendUserMessage(prompt);
		}, 0);
	});

	// Filter pre-handoff messages out of LLM context. After a tool-path
	// handoff, agent.state.messages still holds old messages (we can't call
	// agent.reset()), but the context event controls what the LLM sees.
	pi.on("context", (event) => {
		if (handoffTimestamp === null) return;
		// Timestamp-less messages predate the handoff marker in old session state,
		// so exclude them from the new LLM context.
		const filtered = event.messages.filter((m: any) => (m.timestamp ?? 0) >= handoffTimestamp!);
		if (filtered.length > 0) return { messages: filtered };
		// Don't return an empty array — let the original pass if filter is empty.
	});

	// A genuine new session (/new, /resume, /fork, tree nav) fully resets
	// agent.state.messages. Clear our filter so it doesn't hide them.
	//
	// Also handles the COMMAND-PATH handoff: after cmdCtx.newSession() replaces
	// the runtime, this NEW extension instance's session_start fires. We check
	// globalThis for a pending prompt and apply it with the fresh `pi`.
	pi.on("session_start", async (event, ctx) => {
		handoffTimestamp = null;

		if (event.reason === "new") {
			// Command-path handoff: the new session picks up the stashed prompt
			// + model options here, applied with the fresh `pi`.
			const stash = getPendingHandoffGlobal();
			if (stash) {
				setPendingHandoffGlobal(null);
				if (stash.restore) {
					await restoreHandoffSelection(pi, ctx, stash.restore);
				}
				if (stash.options) {
					await applyHandoffOptions(pi, ctx, stash.options);
				}
				pi.sendUserMessage(stash.prompt);
			}
		} else {
			// Defensive: a stash only ever ships with a reason === "new" start. If
			// one leaked (e.g. a prior newSession() that never fired its start
			// event), clear it now so it can't fire on a later, unrelated "/new"
			// and inject a stale handoff prompt into a fresh session.
			setPendingHandoffGlobal(null);
		}
	});

	// Defensive: clear a leaked stash on shutdown. A command-path handoff is
	// the exception — newSession() fires session_shutdown on THIS (old)
	// instance immediately before the fresh instance's session_start consumes
	// the stash, so clearing here would race that start handler and lose the
	// handoff. commandHandoffPending marks exactly that case.
	pi.on("session_shutdown", () => {
		if (commandHandoffPending) {
			commandHandoffPending = false;
			return;
		}
		setPendingHandoffGlobal(null);
	});

	// /handoff command — primary entry point.
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (-mode <name>, -model <provider/id>)",
		handler: async (args, ctx) => {
			const { options, goal } = parseHandoffArgs(args);
			if (!goal) {
				ctx.ui.notify("Usage: /handoff [-mode <name>] [-model <provider/id>] <goal>", "error");
				return;
			}
			const hasOptions = !!options.mode || !!options.model;
			const error = await performHandoff(
				pi,
				ctx,
				goal,
				true,
				() => {},
				() => {
					commandHandoffPending = true;
				},
				hasOptions ? options : undefined,
			);
			if (error) ctx.ui.notify(error, "error");
		},
	});

	// handoff tool — agent-callable. ONLY when the user explicitly requests it.
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. Provide a goal describing what the new session should focus on.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal/task for the new session" }),
			mode: Type.Optional(
				Type.String({
					description:
						"Optional: start the new session in a named modes.json preset (e.g. 'rush', 'smart', 'deep'). Only based on explicit user instructions.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Optional: start the new session with a specific model, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5'). Only based on explicit user instructions.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options: HandoffOptions = {};
			if (params.mode) options.mode = params.mode as string;
			if (params.model) options.model = params.model as string;
			const hasOptions = !!options.mode || !!options.model;
			const error = await performHandoff(
				pi,
				ctx,
				(params.goal as string) ?? "",
				false,
				(v) => {
					pending = v;
				},
				() => {},
				hasOptions ? options : undefined,
			);
			return {
				content: [
					{
						type: "text",
						text: error ?? "Handoff initiated. The session will switch after the current turn completes.",
					},
				],
				details: {},
			};
		},

		renderCall(args, theme) {
			const parts: string[] = [];

			const goal = (args.goal as string) ?? "";
			const goalLines = goal.split("\n");
			const truncatedGoal = goalLines.length > 5
				? goalLines.slice(0, 5).join("\n") + "\n" + theme.fg("dim", `… (${goalLines.length - 5} more lines)`)
				: goal;

			parts.push(theme.fg("toolTitle", theme.bold("Handoff ")));

			if (args.mode) {
				parts.push(theme.fg("accent", `-mode ${args.mode as string} `));
			}
			if (args.model) {
				parts.push(theme.fg("accent", `-model ${args.model as string} `));
			}

			parts.push(theme.fg("muted", truncatedGoal));

			return new Text(parts.join(""), 0, 0);
		},
	});
}
