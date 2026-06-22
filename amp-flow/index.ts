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
import subagent from "./subagent.ts";
import btw from "./btw.ts";
import modes from "./modes.ts";

export default function (pi: ExtensionAPI) {
	handoff(pi);
	subagent(pi);
	btw(pi);
	modes(pi);
}
