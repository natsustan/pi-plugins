/**
 * session_query tool — query a previous pi session for context.
 *
 * Loads a session file, serializes its conversation, and asks an LLM to answer
 * a question about it. The analysis uses the QUERIED session's own model
 * (taken from its last model_change entry), falling back to the current
 * session's model. Used by handoff'd sessions to look up parent-session
 * context, but can query any .jsonl session file directly.
 */
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SessionManager,
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type SessionQueryDetails = {
	sessionPath?: string;
	question?: string;
	answer?: string;
	messageCount?: number;
	truncated?: boolean;
	error?: boolean;
	empty?: boolean;
	cancelled?: boolean;
};

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

/** Cap serialized session size sent to the model (≈ 15-20k tokens). Parent
 * sessions handed off from can be very long; without a cap this easily blows
 * the queried model's context window and runs up cost. Keeps the tail (most
 * recent, usually most relevant) content. */
const MAX_SESSION_CHARS = 60000;

function truncateSessionText(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_SESSION_CHARS) return { text, truncated: false };
	return {
		text: `[... earlier session content truncated; showing the most recent ${MAX_SESSION_CHARS} characters ...]\n\n${text.slice(text.length - MAX_SESSION_CHARS)}`,
		truncated: true,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Query a previous pi session file for context, decisions, or information. Use when you need to look up what happened in a parent session or any other session.",
		parameters: Type.Object({
			sessionPath: Type.String({
				description:
					"Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl). The handoff prompt includes this as the 'Parent session' path.",
			}),
			question: Type.String({
				description:
					"What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
		}),

		renderResult(result, _options, theme) {
			const container = new Container();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const details = result.details as SessionQueryDetails | undefined;
			if (details?.question && details.answer !== undefined) {
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", details.question), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(details.answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (t: string) => theme.fg("toolOutput", t),
					}),
				);
			} else {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
			}
			// Meta footer: message count (and truncation flag).
			const count = details?.messageCount;
			if (typeof count === "number") {
				const metaParts = [`${count} message${count === 1 ? "" : "s"}`];
				if (details?.truncated) metaParts.push("truncated");
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", metaParts.join(" · ")), 0, 0));
			}
			return container;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { sessionPath, question } = params as { sessionPath: string; question: string };

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
			}

			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			// Build the session context the same way pi does for a real turn —
			// this resolves compaction summaries, branch summaries, and custom
			// context messages instead of sending only raw message entries
			// (which would omit summaries yet still include pre-compaction
			// history after /compact).
			const context = sessionManager.buildSessionContext();

			if (context.messages.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Session is empty — no messages found." }],
					details: { empty: true },
				};
			}

			const { text: conversationText, truncated } = truncateSessionText(
				serializeConversation(convertToLlm(context.messages)),
			);

			// Prefer the queried session's own model (resolved from its entry
			// tree, honoring model_change entries); fall back to the current
			// session's model.
			let queryModel = ctx.model;
			if (context.model) {
				const sessionModel = ctx.modelRegistry.find(context.model.provider, context.model.modelId);
				if (sessionModel) queryModel = sessionModel;
			}
			if (!queryModel) {
				return errorResult("Error: No model available to analyze the session.");
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(queryModel);
				if (!auth.ok) return errorResult(`Error: ${auth.error}`);

				const userMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${question}`,
						},
					],
					timestamp: Date.now(),
				};

				const response = await complete(
					queryModel,
					{ systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal },
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text" as const, text: "Query was cancelled." }],
						details: { cancelled: true },
					};
				}

				const answer = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: answer }],
					details: { sessionPath, question, answer, messageCount: context.messages.length, truncated },
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
