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
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

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
			// Parse the "**Query:** q\n\n---\n\nanswer" envelope we build below.
			const match = text.match(/\*\*Query:\*\* (.+?)\n\n---\n\n([\s\S]+)/);
			if (match) {
				const [, query, answer] = match;
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (t: string) => theme.fg("toolOutput", t),
					}),
				);
			} else {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
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

			try {
				const fs = await import("node:fs");
				if (!fs.existsSync(sessionPath)) {
					return errorResult(`Error: Session file not found: ${sessionPath}`);
				}
			} catch (err) {
				return errorResult(`Error checking session file: ${err}`);
			}

			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			const branch = sessionManager.getBranch();
			const messages = branch
				.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
				.map((e) => e.message);

			if (messages.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Session is empty — no messages found." }],
					details: { empty: true },
				};
			}

			const conversationText = serializeConversation(convertToLlm(messages));

			// Prefer the queried session's own model (last model_change entry);
			// fall back to the current session's model.
			let queryModel = ctx.model;
			const modelChanges = branch.filter(
				(e): e is SessionEntry & { type: "model_change" } => e.type === "model_change",
			);
			if (modelChanges.length > 0) {
				const last = modelChanges[modelChanges.length - 1]!;
				const sessionModel = ctx.modelRegistry.find(last.provider, last.modelId);
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
					content: [{ type: "text" as const, text: `**Query:** ${question}\n\n---\n\n${answer}` }],
					details: { sessionPath, question, messageCount: messages.length },
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
