/**
 * handoff — transfer context to a new focused session.
 *
 * Two entry points:
 *   /handoff <goal>     — command path (ExtensionCommandContext).
 *                         Uses ctx.newSession({ withSession }) for a clean
 *                         session replacement. This is the primary path.
 *   handoff tool        — agent-callable (ExtensionContext, no newSession).
 *                         Stashes the generated prompt and switches via the
 *                         low-level sessionManager in the agent_end handler.
 *
 * The summary is generated with the CURRENT session's model before switching.
 * The new session inherits pi's default model — switch with /model afterwards.
 */
import { complete, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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

	if (response.stopReason === "aborted") return null;

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function extractMessages(ctx: ExtensionContext): any[] {
	const branch = ctx.sessionManager.getBranch();
	return branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
}

/** Build the final prompt: goal first, parent session ref, then summary. */
function buildFinalPrompt(goal: string, summary: string, parentSession: string | undefined): string {
	if (parentSession) {
		return `${goal}\n\n**Parent session:** \`${parentSession}\`\n\n${summary}`;
	}
	return `${goal}\n\n${summary}`;
}

/**
 * Core handoff logic. Returns an error string on failure, undefined on success.
 *
 * Command path uses ctx.newSession({ withSession }) — a full runtime
 * replacement. Tool path can't call newSession (no ExtensionCommandContext),
 * so it stashes the prompt for the agent_end handler to apply via the
 * low-level sessionManager.
 */
async function performHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	fromCommand: boolean,
	stash: (v: { prompt: string; parentSession: string | undefined }) => void,
): Promise<string | undefined> {
	if (!ctx.hasUI) return "Handoff requires interactive mode.";
	if (!ctx.model) return "No model selected.";

	const messages = extractMessages(ctx);
	if (messages.length === 0) return "No conversation to hand off.";

	const parentSession = ctx.sessionManager.getSessionFile();

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

	if (summary === null) return "Handoff cancelled.";

	const finalPrompt = buildFinalPrompt(goal, summary, parentSession);

	if (fromCommand) {
		// Command path: full runtime replacement via newSession({ withSession }).
		// withSession runs after the new session (and its new extension instance)
		// has fully started. We must NOT use the old `pi` here — only the ctx
		// passed to withSession.
		const cmdCtx = ctx as ExtensionCommandContext;
		await cmdCtx.newSession({
			parentSession,
			withSession: async (newCtx) => {
				await newCtx.sendUserMessage(finalPrompt);
			},
		});
	} else {
		// Tool path: stash for the agent_end handler. We can't call newSession
		// from tool context (ExtensionContext lacks it).
		stash({ prompt: finalPrompt, parentSession });
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Tool-path coordination state.
	let pending: { prompt: string; parentSession: string | undefined } | null = null;
	// Timestamp marking the tool-path session switch; used by the context
	// handler to filter out pre-handoff messages that linger in agent state.
	let handoffTimestamp: number | null = null;

	// After the agent loop ends, perform the deferred tool-path switch.
	pi.on("agent_end", (_event, ctx) => {
		if (!pending) return;
		const { prompt, parentSession } = pending;
		pending = null;

		// Record timestamp BEFORE switching — old messages precede it.
		handoffTimestamp = Date.now();

		// Low-level switch: creates a new session file. This does NOT replace
		// the runtime or clear agent.state.messages (we handle that via the
		// context event below). ReadonlySessionManager hides this method at
		// the type level, but it exists at runtime.
		(ctx.sessionManager as any).newSession({ parentSession });

		// Defer to the next macrotask so the old agent loop's cleanup completes
		// before we start a new turn.
		setTimeout(() => {
			pi.sendUserMessage(prompt);
		}, 0);
	});

	// Filter pre-handoff messages out of LLM context. After a tool-path
	// handoff, agent.state.messages still holds old messages (we can't call
	// agent.reset()), but the context event controls what the LLM sees.
	pi.on("context", (event) => {
		if (handoffTimestamp === null) return;
		const filtered = event.messages.filter((m: any) => (m.timestamp ?? 0) >= handoffTimestamp!);
		if (filtered.length > 0) return { messages: filtered };
		// Don't return an empty array — let the original pass if filter is empty.
	});

	// A genuine new session (/new, /resume, /fork, tree nav) fully resets
	// agent.state.messages. Clear our filter so it doesn't hide them.
	pi.on("session_start", () => {
		handoffTimestamp = null;
	});

	// /handoff command — primary entry point.
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal>", "error");
				return;
			}
			const error = await performHandoff(pi, ctx, goal, true, (v) => {
				pending = v;
			});
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
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const error = await performHandoff(pi, ctx, (params.goal as string) ?? "", false, (v) => {
				pending = v;
			});
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
			const goal = (args.goal as string) ?? "";
			const goalLines = goal.split("\n");
			const truncatedGoal = goalLines.length > 5
				? goalLines.slice(0, 5).join("\n") + "\n" + theme.fg("dim", `… (${goalLines.length - 5} more lines)`)
				: goal;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Handoff "))}${theme.fg("muted", truncatedGoal)}`,
				0, 0,
			);
		},
	});
}
