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
	buildSessionContext,
	convertToLlm,
	getMarkdownTheme,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { Type } from "typebox";

type SessionQueryDetails = {
	sessionPath?: string;
	leafId?: string;
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
			leafId: Type.Optional(
				Type.String({
					description:
						"Optional stable parent session leaf id from a handoff prompt. Use this with the Parent session leaf value to query the exact branch that produced the handoff.",
				}),
			),
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
			const { sessionPath, leafId, question } = params as {
				sessionPath: string;
				leafId?: string;
				question: string;
			};

			const errorResult = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { error: true },
			});

			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
			}

			let sessionManager: SessionManager;
			try {
				const stat = fs.statSync(sessionPath);
				if (!stat.isFile()) {
					return errorResult(`Error: Invalid session path. Expected a session file, got: ${sessionPath}`);
				}
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			const targetLeafId = leafId?.trim();
			if (targetLeafId && !sessionManager.getEntry(targetLeafId)) {
				return errorResult(`Error: leafId not found in session: ${targetLeafId}`);
			}

			// Build the session context the same way pi does for a real turn. When
			// a handoff includes a parent leaf id, use it so later parent-session
			// appends or branch changes do not affect the query.
			const context = targetLeafId
				? buildSessionContext(sessionManager.getEntries(), targetLeafId)
				: sessionManager.buildSessionContext();

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
			// session's model if that model is missing or has no credentials.
			const queryModels = [];
			if (context.model) {
				const sessionModel = ctx.modelRegistry.find(context.model.provider, context.model.modelId);
				if (sessionModel) queryModels.push(sessionModel);
			}
			if (ctx.model && !queryModels.some((model) => model.provider === ctx.model!.provider && model.id === ctx.model!.id)) {
				queryModels.push(ctx.model);
			}
			if (queryModels.length === 0) {
				return errorResult("Error: No model available to analyze the session.");
			}

			try {
				let selected:
					| {
						model: typeof queryModels[number];
						apiKey?: string;
						headers?: Record<string, string>;
					}
					| undefined;
				let lastAuthError: string | undefined;
				for (const model of queryModels) {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (auth.ok) {
						selected = { model, apiKey: auth.apiKey, headers: auth.headers };
						break;
					}
					lastAuthError = auth.error;
				}
				if (!selected) return errorResult(`Error: ${lastAuthError ?? "No model credentials available."}`);

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
					selected.model,
					{ systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: selected.apiKey, headers: selected.headers, signal },
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
					details: { sessionPath, leafId: targetLeafId, question, answer, messageCount: context.messages.length, truncated },
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
