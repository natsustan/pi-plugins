/**
 * Minimal modes.json reader shared by handoff.
 *
 * amp-modes owns the full modes runtime (UI, editor badge, thinking lock);
 * here we only need the file format to resolve `-mode <name>` and
 * `-model <provider/id>` flags for handoff. Reads project `.pi/modes.json`
 * first, then global `~/.pi/agent/modes.json`.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
};

export type HandoffOptions = {
	mode?: string;
	model?: string;
};

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getGlobalAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUserPath(env);
	return path.join(os.homedir(), ".pi", "agent");
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	return typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level)
		? (level as ThinkingLevel)
		: undefined;
}

/**
 * Load a single mode spec by name from project or global modes.json.
 * Returns undefined if the mode (or the file) is absent.
 */
export function loadModeSpec(
	cwd: string,
	modeName: string,
): ModeSpec | undefined {
	const candidates = [
		path.join(cwd, ".pi", "modes.json"),
		path.join(getGlobalAgentDir(), "modes.json"),
	];

	for (const modesPath of candidates) {
		try {
			const raw = fs.readFileSync(modesPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.modes && typeof parsed.modes === "object" && parsed.modes[modeName]) {
				const spec = parsed.modes[modeName];
				return {
					provider: typeof spec.provider === "string" ? spec.provider : undefined,
					modelId: typeof spec.modelId === "string" ? spec.modelId : undefined,
					thinkingLevel: normalizeThinkingLevel(spec.thinkingLevel),
				};
			}
		} catch {
			continue;
		}
	}
	return undefined;
}
