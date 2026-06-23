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
		// Mutating subagent tools (bash/edit/write) are only exposed when calls can
		// pass through captured tool_call handlers. Handlers registered before
		// amp-flow loaded are not enumerable here, so allowing writes without any
		// captured handler could bypass an earlier policy/sandbox extension.
		canForwardToolCalls: () => toolCallHandlers.length > 0,
		hasToolCallHandlers: () => toolCallHandlers.length > 0,
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
