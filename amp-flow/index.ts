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
		// Mutating subagent tools (bash/edit/write) stay available to match the
		// reference subagent implementation. tool_call/tool_result events are
		// forwarded to any handlers we captured below.
		//
		// Caveat: handlers registered BEFORE amp-flow loaded are not visible here
		// (we monkeypatched pi.on too late). In the common no-policy case that's
		// fine (the parent has no policy either). But if a policy/sandbox
		// extension is loaded BEFORE amp-flow, its tool_call hooks won't cover
		// subagent calls even though they cover the parent — load amp-flow FIRST
		// if you want a policy extension's hooks to apply to subagents too.
		// Fully closing this gap needs a core API to enumerate existing handlers.
		canForwardToolCalls: () => true,
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
