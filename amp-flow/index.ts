/**
 * amp-flow — Amp Code-like workflows for pi.
 *
 * Bundles three cooperating extensions:
 *   - handoff   /handoff <goal>  + handoff tool — context transfer to a new session
 *   - subagent  subagent tool    — isolated parallel subagents (read/bash/edit/write)
 *   - btw       /btw <prompt>    — background subagent with live widget
 *
 * Install: symlink this dir into ~/.pi/agent/extensions/ (or add to settings.json
 * "extensions"), then `npm install` here so @earendil-works/pi-agent-core
 * (used by the subagent loop) is resolvable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import handoff from "./handoff.ts";
import subagent, { type SubagentToolEventBridge } from "./subagent.ts";
import btw from "./btw.ts";
import sessionQuery from "./session-query.ts";

type ExtensionHandler = (event: any, ctx: any) => unknown | Promise<unknown>;

function createToolEventBridge(pi: ExtensionAPI): SubagentToolEventBridge {
	const toolCallHandlers: ExtensionHandler[] = [];
	const toolResultHandlers: ExtensionHandler[] = [];
	const originalOn = pi.on.bind(pi) as any;

	(pi as any).on = (event: string, handler: ExtensionHandler) => {
		if (event === "tool_call") toolCallHandlers.push(handler);
		if (event === "tool_result") toolResultHandlers.push(handler);
		return originalOn(event, handler);
	};

	return {
		// Expose mutating tools (bash/edit/write) and forward tool_call/tool_result
		// events to any handlers we captured. Handlers registered BEFORE amp-flow
		// loaded aren't visible (we monkeypatched pi.on too late), so they won't
		// apply to subagent calls — subagents otherwise run with fresh builtin
		// tools, same as the reference implementation. Load amp-flow BEFORE a
		// policy/sandbox extension if you want that extension's tool_call hooks to
		// cover subagents too.
		canForwardToolCalls: () => true,
		hasToolResultHandlers: () => toolResultHandlers.length > 0,
		async emitToolCall(event, ctx) {
			let result;
			for (const handler of toolCallHandlers) {
				const handlerResult = await handler(event, ctx);
				if (handlerResult) {
					result = handlerResult;
					if ((result as any).block) return result as any;
				}
			}
			return result as any;
		},
		async emitToolResult(event, ctx) {
			let currentEvent = event;
			let modified = false;
			for (const handler of toolResultHandlers) {
				const handlerResult = await handler(currentEvent, ctx);
				if (!handlerResult) continue;
				modified = true;
				currentEvent = { ...currentEvent, ...handlerResult };
			}
			if (!modified) return undefined;
			return {
				content: currentEvent.content,
				details: currentEvent.details,
				isError: currentEvent.isError,
			};
		},
	};
}

export default function (pi: ExtensionAPI) {
	const toolEvents = createToolEventBridge(pi);
	handoff(pi);
	subagent(pi, toolEvents);
	btw(pi, toolEvents);
	sessionQuery(pi);
}
