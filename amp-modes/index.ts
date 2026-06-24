/**
 * modes — prompt mode manager (model + thinking presets).
 *
 * A "mode" is a named preset of {provider, modelId, thinkingLevel}.
 * Switching modes applies the model + thinking level in one step. The current
 * selection is also reverse-matched to a mode name, so model changes made via
 * Ctrl+P / /model / other extensions sync the active mode label.
 *
 * This module does NOT draw any editor chrome. It publishes the current mode
 * to a process-global mailbox (read by the amp-editor extension, which renders
 * the mode label in its top border) and fires an event to force a re-render.
 * See "CROSS-PACKAGE CONTRACT" below for the shared literals.
 *
 *   /mode              mode picker
 *   /mode <name>       switch directly
 *   /mode store [name] save current selection into a mode
 *   /mode configure    configuration UI
 *   pi --mode <name>   start in a named mode (extension compatibility shim)
 *   pi --prompt-mode <name> same, without overloading pi's built-in --mode
 *   Ctrl+Shift+S       open picker
 *   Ctrl+S             cycle deep → rush → smart
 *   Option+D           in deep mode: cycle deep → deep² → deep³
 *
 * Config: .pi/modes.json (project) → ~/.pi/agent/modes.json (global).
 * Setting `"modes": {}` disables the overlay (labels, shortcuts) while
 * keeping /mode configure available.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent, SettingsManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// =============================================================================
// CROSS-PACKAGE CONTRACT with amp-editor (process-global, no import needed)
// =============================================================================
// amp-editor reads the mailbox + listens on the channel below to render the
// mode badge. Symbol.for is global by construction, but MODE_CHANGE_CHANNEL is
// a plain string and WILL SILENTLY BREAK badge repaints if the two sides drift.
// If you rename it here, rename it in amp-editor/index.ts too (and vice versa).

/** Global mailbox key shared with amp-editor. Symbol.for → globally unique. */
const MODE_MAILBOX = Symbol.for("amp.modes.current");
/** Optional bridge for other extensions that need a real mode switch. */
const MODE_APPLY_BRIDGE = Symbol.for("amp.modes.apply");
/** Event channel — MUST match amp-editor/index.ts exactly. */
const MODE_CHANGE_CHANNEL = "amp:modes-change";

type RGB = { r: number; g: number; b: number };
type ModeUiHints = {
	labelColors: { default?: RGB };
};

export type ModeMailboxValue = { mode: string; uiHints?: ModeUiHints } | null;

/** Read the current mode mailbox (used by amp-editor). Exported for tests. */
export function readModeMailbox(): ModeMailboxValue {
	return (globalThis as any)[MODE_MAILBOX] ?? null;
}

// =============================================================================
// Types and constants
// =============================================================================

type ModeName = string;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
};

type ModesFile = {
	version: 1;
	currentMode: ModeName;
	modes: Record<ModeName, ModeSpec>;
	/** When true (default), snap thinking back to the active mode's preset if a
	 * non-mode change (shift+tab / app.thinking.cycle, settings, …) diverges it.
	 * The keybinding itself is reserved, so this is enforced in the event handler. */
	lockThinkingWhenModeActive?: boolean;
};

type LoadedModes = {
	data: ModesFile;
	/** True when file explicitly contains: "modes": {} */
	explicitlyEmptyModes: boolean;
	/** True only when it is safe to create the missing modes file. */
	canPersistBootstrap: boolean;
	loadError?: string;
};

const CUSTOM_MODE_NAME = "custom" as const;
const DEEP_MODE_NAME = "deep" as const;
const DEEP_THINKING_LEVELS: ThinkingLevel[] = ["medium", "high", "xhigh"];

// Bootstrap defaults written when no modes.json exists. They intentionally
// avoid provider/model pins so the extension works with whatever model the
// user has configured. Edit ~/.pi/agent/modes.json or .pi/modes.json to bind
// modes to specific models.
const BOOTSTRAP_MODES: Array<{ name: ModeName; spec: Pick<ModeSpec, "thinkingLevel"> }> = [
	{ name: "rush", spec: { thinkingLevel: "off" } },
	{ name: "smart", spec: { thinkingLevel: "high" } },
	{ name: "deep", spec: { thinkingLevel: "medium" } },
];

const MODE_UI_CONFIGURE = "Configure modes…";
const MODE_UI_ADD = "Add mode…";
const MODE_UI_BACK = "Back";
const MODE_UI_LOCK_THINKING_ON = "Lock thinking to active mode: on";
const MODE_UI_LOCK_THINKING_OFF = "Lock thinking to active mode: off";

const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_UNSET_LABEL = "(don't change)";

const MODE_UI_HINTS: Record<string, ModeUiHints> = {
	deep: {
		labelColors: { default: { r: 103, g: 255, b: 168 } },
	},
	smart: {
		labelColors: {
			default: { r: 200, g: 230, b: 68 },
		},
	},
	rush: {
		labelColors: {
			default: { r: 255, g: 215, b: 0 },
		},
	},
};

// =============================================================================
// File/path helpers
// =============================================================================

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

function getGlobalModesPath(): string {
	return path.join(getGlobalAgentDir(), "modes.json");
}

function getProjectModesPath(cwd: string): string {
	return path.join(cwd, ".pi", "modes.json");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function getMtimeMs(p: string): Promise<number | null> {
	try {
		const st = await fs.stat(p);
		return st.mtimeMs;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPathForFile(filePath: string): string {
	return `${filePath}.lock`;
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = getLockPathForFile(filePath);
	await ensureDirForFile(lockPath);

	const start = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
					"utf8",
				);
			} catch {
				// ignore
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			try {
				const st = await fs.stat(lockPath);
				if (Date.now() - st.mtimeMs > 30_000) {
					await fs.unlink(lockPath);
					continue;
				}
			} catch {
				// ignore
			}

			if (Date.now() - start > 5_000) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}

			await sleep(40 + Math.random() * 80);
		}
	}
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await ensureDirForFile(filePath);

	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);
	await fs.writeFile(tmpPath, content, "utf8");

	try {
		await fs.rename(tmpPath, filePath);
	} catch (err: any) {
		if (err?.code === "EEXIST" || err?.code === "EPERM") {
			await fs.unlink(filePath).catch(() => {});
			await fs.rename(tmpPath, filePath);
		} else {
			await fs.unlink(tmpPath).catch(() => {});
			throw err;
		}
	}
}

// =============================================================================
// Modes file helpers
// =============================================================================

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level as ThinkingLevel;
	return ALL_THINKING_LEVELS.includes(v) ? v : undefined;
}

function sanitizeModeSpec(spec: unknown): ModeSpec {
	const obj = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	return {
		provider: typeof obj.provider === "string" ? obj.provider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
		thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
	};
}

/** Read the thinking-lock flag from a raw parsed modes file. Default ON: a mode
 *  is a fixed model+thinking preset, so thinking stays pinned to it unless the
 *  user opts out (via /mode configure). */
function readLockThinkingFlag(parsed: Record<string, unknown>): boolean {
	return parsed.lockThinkingWhenModeActive !== false;
}

function createBootstrapModesFile(): ModesFile {
	const modes: Record<ModeName, ModeSpec> = {};
	for (const mode of BOOTSTRAP_MODES) {
		modes[mode.name] = { ...mode.spec };
	}
	return { version: 1, currentMode: "smart", modes, lockThinkingWhenModeActive: true };
}

function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
	return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

function ensureCurrentModeValid(file: ModesFile): void {
	const names = orderedModeNames(file.modes);
	if (names.length === 0) {
		file.currentMode = "";
		return;
	}
	if (!file.currentMode || !(file.currentMode in file.modes) || file.currentMode === CUSTOM_MODE_NAME) {
		file.currentMode = names.includes("smart") ? "smart" : names[0]!;
	}
}

async function loadModesFile(filePath: string): Promise<LoadedModes> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		const hasModesProp = Object.prototype.hasOwnProperty.call(parsed, "modes");
		const parsedModesRaw = parsed.modes;
		const modesRaw =
			typeof parsedModesRaw === "object" && parsedModesRaw !== null
				? (parsedModesRaw as Record<string, unknown>)
				: undefined;

		if (!hasModesProp || !modesRaw) {
			return {
				data: createBootstrapModesFile(),
				explicitlyEmptyModes: false,
				canPersistBootstrap: false,
				loadError: `${filePath} does not contain a valid modes object`,
			};
		}

		if (hasModesProp && modesRaw && Object.keys(modesRaw).length === 0) {
			return {
				data: { version: 1, currentMode: "", modes: {}, lockThinkingWhenModeActive: readLockThinkingFlag(parsed) },
				explicitlyEmptyModes: true,
				canPersistBootstrap: false,
			};
		}

		const modes: Record<string, ModeSpec> = {};
		for (const [k, v] of Object.entries(modesRaw ?? {})) {
			modes[k] = sanitizeModeSpec(v);
		}

		const currentMode = typeof parsed.currentMode === "string" ? parsed.currentMode : "";
		const lockThinkingWhenModeActive = readLockThinkingFlag(parsed);
		const file: ModesFile = { version: 1, currentMode, modes, lockThinkingWhenModeActive };

		if (orderedModeNames(file.modes).length === 0) {
			return {
				data: createBootstrapModesFile(),
				explicitlyEmptyModes: false,
				canPersistBootstrap: false,
				loadError: `${filePath} does not contain any named modes`,
			};
		}

		ensureCurrentModeValid(file);
		return { data: file, explicitlyEmptyModes: false, canPersistBootstrap: false };
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return {
				data: createBootstrapModesFile(),
				explicitlyEmptyModes: false,
				canPersistBootstrap: true,
			};
		}
		return {
			data: createBootstrapModesFile(),
			explicitlyEmptyModes: false,
			canPersistBootstrap: false,
			loadError: error instanceof Error ? error.message : String(error),
		};
	}
}

async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
	ensureCurrentModeValid(data);
	await atomicWriteUtf8(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function resolveModesPath(cwd: string): Promise<string> {
	const projectPath = getProjectModesPath(cwd);
	if (await fileExists(projectPath)) return projectPath;
	return getGlobalModesPath();
}

function cloneModesFile(file: ModesFile): ModesFile {
	return JSON.parse(JSON.stringify(file)) as ModesFile;
}

// =============================================================================
// Runtime state
// =============================================================================

type ModeRuntime = {
	filePath: string;
	fileMtimeMs: number | null;
	data: ModesFile;
	explicitlyEmptyModes: boolean;
	overlayEnabled: boolean;
	lockThinkingWhenModeActive: boolean;
	lastRealMode: string;
	currentMode: string;
	applying: boolean;
};

const runtime: ModeRuntime = {
	filePath: "",
	fileMtimeMs: null,
	data: createBootstrapModesFile(),
	explicitlyEmptyModes: false,
	overlayEnabled: true,
	lockThinkingWhenModeActive: true,
	lastRealMode: "smart",
	currentMode: "smart",
	applying: false,
};

// We track model select events to avoid stale ctx.model snapshots.
let lastObservedModel: { provider?: string; modelId?: string } = {};

// Serializes cycle shortcut repeats so rapid key repeats can't race mode inference.
let modeCycleQueue: Promise<void> = Promise.resolve();

// Re-entrancy guard for the thinking lock: our revert calls pi.setThinkingLevel(),
// which re-emits thinking_level_select synchronously. This flag short-circuits the
// re-entry so we don't loop.
let revertingThinking = false;

const BUILTIN_APP_MODES = new Set(["text", "json", "rpc"]);

function readCliValue(longName: string): string | undefined {
	const args = process.argv.slice(2);
	const eqPrefix = `--${longName}=`;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg?.startsWith(eqPrefix)) return arg.slice(eqPrefix.length).trim();
		if (arg === `--${longName}`) {
			const next = args[i + 1];
			if (next && !next.startsWith("-") && !next.startsWith("@")) return next.trim();
		}
	}
	return undefined;
}

function readStartupModeFlag(pi: ExtensionAPI): string | undefined {
	const promptMode = pi.getFlag("prompt-mode");
	if (typeof promptMode === "string" && promptMode.trim()) return promptMode.trim();

	const ampMode = pi.getFlag("amp-mode");
	if (typeof ampMode === "string" && ampMode.trim()) return ampMode.trim();

	// Compatibility shim for the desired Amp-style spelling:
	//   pi --mode deep
	// pi core already owns --mode for app output modes (json/rpc/text), but for
	// any other value it currently consumes the argument and leaves the app mode
	// unset. Reading raw argv here lets amp-modes treat those non-core values as
	// named prompt modes without interfering with --mode json/rpc/text.
	const rawMode = readCliValue("mode");
	if (rawMode && !BUILTIN_APP_MODES.has(rawMode)) return rawMode;

	return undefined;
}

async function applyStartupModeFlag(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const startupMode = readStartupModeFlag(pi);
	if (!startupMode) return false;

	await ensureRuntime(pi, ctx);
	if (!runtime.overlayEnabled) {
		if (ctx.hasUI) ctx.ui.notify("Mode overlay is disabled; startup mode ignored.", "warning");
		return false;
	}

	if (!runtime.data.modes[startupMode]) {
		const available = orderedModeNames(runtime.data.modes).join(", ") || "(none)";
		if (ctx.hasUI) ctx.ui.notify(`Unknown mode "${startupMode}". Available: ${available}`, "warning");
		return false;
	}

	await applyMode(pi, ctx, startupMode);
	return true;
}

async function ensureRuntime(_pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const filePath = await resolveModesPath(ctx.cwd);
	const mtimeMs = await getMtimeMs(filePath);

	const filePathChanged = runtime.filePath !== filePath;
	const fileChanged = filePathChanged || runtime.fileMtimeMs !== mtimeMs;
	if (fileChanged) {
		runtime.filePath = filePath;
		runtime.fileMtimeMs = mtimeMs;

		const loaded = await loadModesFile(filePath);
		runtime.data = loaded.data;
		runtime.explicitlyEmptyModes = loaded.explicitlyEmptyModes;
		runtime.overlayEnabled = !loaded.explicitlyEmptyModes && orderedModeNames(loaded.data.modes).length > 0;
		runtime.lockThinkingWhenModeActive = loaded.data.lockThinkingWhenModeActive !== false;

		if (loaded.loadError && ctx.hasUI) {
			ctx.ui.notify(`Could not read modes config; using defaults without overwriting it. ${loaded.loadError}`, "warning");
		}

		// First run: no modes.json anywhere. Persist the bootstrap defaults so
		// the user can discover and edit them. Ignore write errors gracefully.
		if (loaded.canPersistBootstrap && !loaded.explicitlyEmptyModes) {
			await saveModesFile(filePath, loaded.data).catch(() => {});
			runtime.fileMtimeMs = await getMtimeMs(filePath);
		}

		if (!runtime.overlayEnabled) {
			runtime.currentMode = CUSTOM_MODE_NAME;
			runtime.lastRealMode = "";
		} else {
			ensureCurrentModeValid(runtime.data);
			if (!runtime.currentMode || !(runtime.currentMode in runtime.data.modes) || runtime.currentMode === CUSTOM_MODE_NAME) {
				runtime.currentMode = runtime.data.currentMode;
			}
			if (!runtime.lastRealMode || !(runtime.lastRealMode in runtime.data.modes)) {
				runtime.lastRealMode = runtime.currentMode;
			}
		}
	}
}

async function mutateModesFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mutator: (data: ModesFile) => void,
): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.filePath) return;

	await withFileLock(runtime.filePath, async () => {
		const loaded = await loadModesFile(runtime.filePath);
		if (loaded.loadError) {
			throw new Error(`Could not read modes config; refusing to overwrite it. ${loaded.loadError}`);
		}
		const next = cloneModesFile(loaded.data);
		mutator(next);

		const names = orderedModeNames(next.modes);
		if (names.length === 0) {
			next.currentMode = "";
		}

		await saveModesFile(runtime.filePath, next);
	});

	// Force refresh on next ensureRuntime call.
	runtime.fileMtimeMs = null;
	await ensureRuntime(pi, ctx);
}

// =============================================================================
// Publishing to amp-editor (mailbox + event)
// =============================================================================

/**
 * Write the current mode to the process-global mailbox and notify listeners.
 * amp-editor reads this on each render to label the top border.
 */
let lastPublishedModeKey: string | undefined;

function emitModeChange(pi: ExtensionAPI, value: ModeMailboxValue): void {
	try {
		pi.events.emit(MODE_CHANGE_CHANNEL, value);
	} catch {
		// events may be unavailable in non-interactive modes — ignore.
	}
}

function displayModeName(pi: ExtensionAPI, mode: string): string {
	if (mode !== DEEP_MODE_NAME) return mode;
	const level = pi.getThinkingLevel();
	if (level === "high") return "deep²";
	if (level === "xhigh") return "deep³";
	return mode;
}

function isDeepThinkingVariant(level: ThinkingLevel | undefined): boolean {
	return level === "medium" || level === "high" || level === "xhigh";
}

function isDefaultDeepSpec(name: string, spec: ModeSpec | undefined): boolean {
	return name === DEEP_MODE_NAME && spec?.thinkingLevel === "medium";
}

function publishMode(pi: ExtensionAPI): void {
	let value: ModeMailboxValue = null;
	if (runtime.overlayEnabled && runtime.currentMode !== "" && runtime.currentMode !== CUSTOM_MODE_NAME) {
		value = { mode: displayModeName(pi, runtime.currentMode), uiHints: MODE_UI_HINTS[runtime.currentMode] };
	}
	(globalThis as any)[MODE_MAILBOX] = value;

	// Avoid duplicate change events for the same visible mode. applyMode(),
	// model_select, thinking_level_select, and before_agent_start can all
	// converge on the same value; amp-editor only needs one repaint.
	const key = value ? value.mode : "custom";
	if (key === lastPublishedModeKey) return;
	lastPublishedModeKey = key;

	// Fire-and-forget; amp-editor listens to force a re-render even when the
	// mode label changes without a model/thinking event (rare, but covers
	// before_agent_start inference).
	emitModeChange(pi, value);
}

function clearPublishedMode(pi: ExtensionAPI): void {
	(globalThis as any)[MODE_MAILBOX] = null;
	lastPublishedModeKey = undefined;
	emitModeChange(pi, null);
}

// =============================================================================
// Mode matching / selection
// =============================================================================

type SelectionSnapshot = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	supportsThinking: boolean;
};

function getCurrentSelectionSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): SelectionSnapshot {
	const provider = lastObservedModel.provider ?? ctx.model?.provider;
	const modelId = lastObservedModel.modelId ?? ctx.model?.id;
	const thinkingLevel = pi.getThinkingLevel();

	let supportsThinking = Boolean(ctx.model?.reasoning);
	if (provider && modelId) {
		const model = ctx.modelRegistry.find(provider, modelId) as any;
		if (model) {
			supportsThinking = Boolean(model.reasoning);
		} else if (ctx.model?.provider === provider && ctx.model?.id === modelId) {
			supportsThinking = Boolean(ctx.model.reasoning);
		}
	}

	return { provider, modelId, thinkingLevel, supportsThinking };
}

function getCurrentSelectionSpec(pi: ExtensionAPI, ctx: ExtensionContext): ModeSpec {
	const s = getCurrentSelectionSnapshot(pi, ctx);
	return { provider: s.provider, modelId: s.modelId, thinkingLevel: s.thinkingLevel };
}

function inferModeFromSelection(selection: SelectionSnapshot, data: ModesFile, activeMode?: string): string | null {
	const { provider, modelId, thinkingLevel, supportsThinking } = selection;
	if (!provider || !modelId) return null;

	const names = orderedModeNames(data.modes);
	if (supportsThinking) {
		const candidates: string[] = [];
		for (const name of names) {
			const spec = data.modes[name];
			if (!spec) continue;
			if (spec.provider && spec.provider !== provider) continue;
			if (spec.modelId && spec.modelId !== modelId) continue;
			candidates.push(name);
		}
		if (activeMode === DEEP_MODE_NAME && isDeepThinkingVariant(thinkingLevel)) {
			for (const name of candidates) {
				const spec = data.modes[name];
				if (isDefaultDeepSpec(name, spec)) return name;
			}
		}
		for (const name of candidates) {
			const spec = data.modes[name];
			if (!spec) continue;
			if (spec.thinkingLevel === thinkingLevel) return name;
		}
		if (isDeepThinkingVariant(thinkingLevel)) {
			for (const name of candidates) {
				const spec = data.modes[name];
				if (isDefaultDeepSpec(name, spec)) return name;
			}
		}
		for (const name of candidates) {
			const spec = data.modes[name];
			if (!spec) continue;
			if (!spec.thinkingLevel) return name;
		}
		return null;
	}

	const candidates: string[] = [];
	for (const name of names) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (spec.provider && spec.provider !== provider) continue;
		if (spec.modelId && spec.modelId !== modelId) continue;
		candidates.push(name);
	}
	if (candidates.length === 0) return null;

	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if ((spec.thinkingLevel ?? "off") === thinkingLevel) return name;
	}
	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (!spec.thinkingLevel) return name;
	}

	return candidates[0] ?? null;
}

async function syncModeFromCurrentSelection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.overlayEnabled) {
		publishMode(pi);
		return;
	}

	const inferred = inferModeFromSelection(getCurrentSelectionSnapshot(pi, ctx), runtime.data, runtime.currentMode);
	if (inferred) {
		runtime.currentMode = inferred;
		runtime.lastRealMode = inferred;
	} else {
		if (runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.lastRealMode = runtime.currentMode;
		}
		runtime.currentMode = CUSTOM_MODE_NAME;
	}

	publishMode(pi);
}

async function storeSelectionIntoMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string, selection: ModeSpec): Promise<void> {
	if (mode === CUSTOM_MODE_NAME) return;

	await mutateModesFile(pi, ctx, (data) => {
		const existing = data.modes[mode] ?? {};
		const next: ModeSpec = { ...existing };
		if (selection.provider && selection.modelId) {
			next.provider = selection.provider;
			next.modelId = selection.modelId;
		}
		if (selection.thinkingLevel) {
			next.thinkingLevel = selection.thinkingLevel;
		}
		data.modes[mode] = next;
		ensureCurrentModeValid(data);
	});
}

async function applyMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	await ensureRuntime(pi, ctx);

	if (!runtime.overlayEnabled) {
		if (ctx.hasUI) {
			ctx.ui.notify("Mode overlay is disabled (modes.json has \"modes\": {}). Use /mode to configure.", "info");
		}
		return;
	}

	if (mode === CUSTOM_MODE_NAME) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		publishMode(pi);
		return;
	}

	const spec = runtime.data.modes[mode];
	if (!spec) {
		if (ctx.hasUI) ctx.ui.notify(`Unknown mode: ${mode}`, "warning");
		return;
	}

	runtime.currentMode = mode;
	runtime.lastRealMode = mode;

	// Publish the committed mode BEFORE the async model/thinking work. amp-editor
	// re-renders on the model_select / thinking_level_select events that fire
	// mid-applyMode (it has no `applying` guard). If we wait until the trailing
	// syncMode below, those intermediate renders read a STALE mailbox and paint
	// the *previous* mode label over the *new* model/thinking — e.g. cycling
	// smart→deep briefly shows " smart (medium) " (smart label, deep's thinking).
	// Publishing on commit makes every intermediate render show the target mode.
	publishMode(pi);

	runtime.applying = true;
	let modelAppliedOk = true;
	try {
		if (spec.provider && spec.modelId) {
			const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (model) {
				const ok = await pi.setModel(model);
				modelAppliedOk = ok;
				if (ok) {
					// Keep an immediate, non-stale model snapshot even if ctx.model lags event delivery.
					lastObservedModel = { provider: spec.provider, modelId: spec.modelId };
				}
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
				}
			} else {
				modelAppliedOk = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Mode "${mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
				}
			}
		}

		if (modelAppliedOk && spec.thinkingLevel) {
			pi.setThinkingLevel(spec.thinkingLevel);
		}
	} finally {
		runtime.applying = false;
	}

	if (!modelAppliedOk) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		publishMode(pi);
		return;
	}

	// Ensure model+thinking pairing still resolves exactly (handles clamping/overrides).
	// syncModeFromCurrentSelection() publishes the mode, so don't publish again here.
	await syncModeFromCurrentSelection(pi, ctx);
}

const QUICK_CYCLE_MODES = ["deep", "rush", "smart"];

async function cycleModeNow(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.overlayEnabled) return;

	const quickNames = QUICK_CYCLE_MODES.filter((name) => runtime.data.modes[name]);
	const names = quickNames.length > 0 ? quickNames : orderedModeNames(runtime.data.modes);
	if (names.length === 0) return;

	const baseMode = runtime.currentMode === CUSTOM_MODE_NAME ? runtime.lastRealMode : runtime.currentMode;
	const idx = names.includes(baseMode) ? names.indexOf(baseMode) : -1;
	const next = names[(idx + direction + names.length) % names.length] ?? names[0]!;
	await applyMode(pi, ctx, next);
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	const run = modeCycleQueue.then(() => cycleModeNow(pi, ctx, direction), () => cycleModeNow(pi, ctx, direction));
	modeCycleQueue = run.then(() => undefined, () => undefined);
	await run;
}

async function cycleDeepThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await ensureRuntime(pi, ctx);
	if (!runtime.overlayEnabled || runtime.currentMode !== DEEP_MODE_NAME) return;

	const spec = runtime.data.modes[DEEP_MODE_NAME];
	if (!isDefaultDeepSpec(DEEP_MODE_NAME, spec)) return;

	const current = pi.getThinkingLevel() as ThinkingLevel;
	const idx = DEEP_THINKING_LEVELS.indexOf(current);
	const next = DEEP_THINKING_LEVELS[(idx + 1) % DEEP_THINKING_LEVELS.length] ?? "medium";

	runtime.applying = true;
	try {
		pi.setThinkingLevel(next);
	} finally {
		runtime.applying = false;
	}

	if (isDeepThinkingVariant(pi.getThinkingLevel() as ThinkingLevel)) {
		runtime.currentMode = DEEP_MODE_NAME;
		runtime.lastRealMode = DEEP_MODE_NAME;
		publishMode(pi);
	} else {
		await syncModeFromCurrentSelection(pi, ctx);
	}
}

// =============================================================================
// UI: mode management
// =============================================================================

function isReservedModeName(name: string): boolean {
	return name === CUSTOM_MODE_NAME || name === MODE_UI_CONFIGURE || name === MODE_UI_ADD || name === MODE_UI_BACK;
}

function normalizeModeNameInput(name: string | undefined): string {
	return (name ?? "").trim();
}

function validateModeNameOrError(
	name: string,
	existing: Record<string, ModeSpec>,
	opts?: { allowExisting?: boolean },
): string | null {
	if (!name) return "Mode name cannot be empty";
	if (/\s/.test(name)) return "Mode name cannot contain whitespace";
	if (isReservedModeName(name)) return `Mode name "${name}" is reserved`;
	if (!opts?.allowExisting && existing[name]) return `Mode "${name}" already exists`;
	return null;
}

async function pickModelForModeUI(
	ctx: ExtensionContext,
	spec: ModeSpec,
): Promise<{ provider: string; modelId: string } | undefined> {
	if (!ctx.hasUI) return undefined;

	const settingsManager = SettingsManager.inMemory();
	const currentModel = spec.provider && spec.modelId ? ctx.modelRegistry.find(spec.provider, spec.modelId) : ctx.model;
	const scopedModels: Array<{ model: any; thinkingLevel: string }> = [];

	return ctx.ui.custom<{ provider: string; modelId: string } | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			currentModel,
			settingsManager,
			ctx.modelRegistry as any,
			scopedModels as any,
			(model) => done({ provider: model.provider, modelId: model.id }),
			() => done(undefined),
		);
		return selector;
	});
}

async function pickThinkingLevelForModeUI(
	ctx: ExtensionContext,
	_current: ThinkingLevel | undefined,
): Promise<ThinkingLevel | null | undefined> {
	if (!ctx.hasUI) return undefined;

	const options = [...ALL_THINKING_LEVELS, THINKING_UNSET_LABEL];
	const choice = await ctx.ui.select("Thinking level", options);
	if (!choice) return undefined;
	if (choice === THINKING_UNSET_LABEL) return null;
	if (ALL_THINKING_LEVELS.includes(choice as ThinkingLevel)) return choice as ThinkingLevel;
	return undefined;
}

function renameModesRecord(modes: Record<string, ModeSpec>, oldName: string, newName: string): Record<string, ModeSpec> {
	const out: Record<string, ModeSpec> = {};
	for (const [k, v] of Object.entries(modes)) {
		if (k === oldName) out[newName] = v;
		else out[k] = v;
	}
	return out;
}

async function addModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input("New mode name", "e.g. docs, review, planning");
		if (raw === undefined) return undefined;

		const name = normalizeModeNameInput(raw);
		const err = validateModeNameOrError(name, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		const selection = getCurrentSelectionSpec(pi, ctx);
		await mutateModesFile(pi, ctx, (data) => {
			data.modes[name] = {
				provider: selection.provider,
				modelId: selection.modelId,
				thinkingLevel: selection.thinkingLevel,
			};
			if (!data.currentMode) data.currentMode = name;
		});

		await syncModeFromCurrentSelection(pi, ctx);
		ctx.ui.notify(`Added mode "${name}"`, "info");
		return name;
	}
}

async function renameModeUI(pi: ExtensionAPI, ctx: ExtensionContext, oldName: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input(`Rename mode "${oldName}"`, oldName);
		if (raw === undefined) return undefined;

		const newName = normalizeModeNameInput(raw);
		if (!newName || newName === oldName) return oldName;

		const err = validateModeNameOrError(newName, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		await mutateModesFile(pi, ctx, (data) => {
			data.modes = renameModesRecord(data.modes, oldName, newName);
			if (data.currentMode === oldName) data.currentMode = newName;
		});

		if (runtime.currentMode === oldName) runtime.currentMode = newName;
		if (runtime.lastRealMode === oldName) runtime.lastRealMode = newName;

		await syncModeFromCurrentSelection(pi, ctx);
		ctx.ui.notify(`Renamed "${oldName}" → "${newName}"`, "info");
		return newName;
	}
}

async function editModeUI(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	if (!ctx.hasUI) return;
	let modeName = mode;

	while (true) {
		await ensureRuntime(pi, ctx);
		if (!runtime.data.modes[modeName]) return;
		const spec = runtime.data.modes[modeName]!;

		const modelLabel = spec.provider && spec.modelId ? `${spec.provider}/${spec.modelId}` : "(no model)";
		const thinkingLabel = spec.thinkingLevel ?? THINKING_UNSET_LABEL;

		const actions = ["Change name", "Change model", "Change thinking level", "Delete mode", MODE_UI_BACK];
		const action = await ctx.ui.select(
			`Edit mode "${modeName}"  model: ${modelLabel}  thinking: ${thinkingLabel}`,
			actions,
		);
		if (!action || action === MODE_UI_BACK) return;

		if (action === "Change name") {
			const renamed = await renameModeUI(pi, ctx, modeName);
			if (renamed) modeName = renamed;
			continue;
		}

		if (action === "Change model") {
			const selected = await pickModelForModeUI(ctx, spec);
			if (!selected) continue;

			await mutateModesFile(pi, ctx, (data) => {
				const m = data.modes[modeName] ?? {};
				m.provider = selected.provider;
				m.modelId = selected.modelId;
				data.modes[modeName] = m;
			});

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			} else {
				await syncModeFromCurrentSelection(pi, ctx);
			}
			ctx.ui.notify(`Updated model for "${modeName}"`, "info");
			continue;
		}

		if (action === "Change thinking level") {
			const level = await pickThinkingLevelForModeUI(ctx, spec.thinkingLevel);
			if (level === undefined) continue;

			await mutateModesFile(pi, ctx, (data) => {
				const m = data.modes[modeName] ?? {};
				if (level === null) delete m.thinkingLevel;
				else m.thinkingLevel = level;
				data.modes[modeName] = m;
			});

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			} else {
				await syncModeFromCurrentSelection(pi, ctx);
			}
			ctx.ui.notify(`Updated thinking level for "${modeName}"`, "info");
			continue;
		}

		if (action === "Delete mode") {
			const ok = await ctx.ui.confirm("Delete mode", `Delete mode "${modeName}"?`);
			if (!ok) continue;

			const wasCurrentMode = runtime.currentMode === modeName;
			await mutateModesFile(pi, ctx, (data) => {
				delete data.modes[modeName];
				ensureCurrentModeValid(data);
			});

			if (!runtime.overlayEnabled) {
				runtime.currentMode = CUSTOM_MODE_NAME;
			} else if (wasCurrentMode) {
				await syncModeFromCurrentSelection(pi, ctx);
			}
			if (runtime.lastRealMode === modeName) {
				runtime.lastRealMode = runtime.data.currentMode;
			}

			publishMode(pi);
			ctx.ui.notify(`Deleted mode "${modeName}"`, "info");
			return;
		}
	}
}

async function configureModesUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const lockLabel = runtime.lockThinkingWhenModeActive ? MODE_UI_LOCK_THINKING_ON : MODE_UI_LOCK_THINKING_OFF;
		const options = [...names, MODE_UI_ADD, lockLabel, MODE_UI_BACK];
		const title = runtime.overlayEnabled
			? `Configure modes (current: ${runtime.currentMode})`
			: "Configure modes (overlay disabled: modes is empty)";
		const choice = await ctx.ui.select(title, options);
		if (!choice || choice === MODE_UI_BACK) return;

		if (choice === MODE_UI_ADD) {
			const created = await addModeUI(pi, ctx);
			if (created) {
				await editModeUI(pi, ctx, created);
			}
			continue;
		}

		if (choice === lockLabel) {
			await mutateModesFile(pi, ctx, (data) => {
				data.lockThinkingWhenModeActive = !runtime.lockThinkingWhenModeActive;
			});
			ctx.ui.notify(
				runtime.lockThinkingWhenModeActive
					? "Thinking now locked to active mode"
					: "Thinking no longer locked to active mode",
				"info",
			);
			continue;
		}

		await editModeUI(pi, ctx, choice);
	}
}

async function handleModeChoiceUI(pi: ExtensionAPI, ctx: ExtensionContext, choice: string): Promise<void> {
	if (runtime.currentMode === CUSTOM_MODE_NAME && choice !== CUSTOM_MODE_NAME) {
		const action = await ctx.ui.select(`Mode "${choice}"`, ["use", "store"]);
		if (!action) return;

		if (action === "use") {
			await applyMode(pi, ctx, choice);
			return;
		}

		const overlay = getCurrentSelectionSpec(pi, ctx);
		await storeSelectionIntoMode(pi, ctx, choice, overlay);
		await applyMode(pi, ctx, choice);
		ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into "${choice}"`, "info");
		return;
	}

	await applyMode(pi, ctx, choice);
}

async function selectModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);

		if (!runtime.overlayEnabled) {
			const choice = await ctx.ui.select("Mode overlay disabled", [MODE_UI_CONFIGURE, MODE_UI_BACK]);
			if (!choice || choice === MODE_UI_BACK) return;
			await configureModesUI(pi, ctx);
			continue;
		}

		const names = orderedModeNames(runtime.data.modes);
		const choice = await ctx.ui.select(`Mode (current: ${runtime.currentMode})`, [...names, MODE_UI_CONFIGURE]);
		if (!choice) return;

		if (choice === MODE_UI_CONFIGURE) {
			await configureModesUI(pi, ctx);
			continue;
		}

		await handleModeChoiceUI(pi, ctx, choice);
		return;
	}
}

// =============================================================================
// Extension export
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerFlag("prompt-mode", {
		description: "Start in a named amp prompt mode (rush, smart, deep, ...)",
		type: "string",
	});
	pi.registerFlag("amp-mode", {
		description: "Alias for --prompt-mode",
		type: "string",
	});

	const applyBridge = async (targetPi: ExtensionAPI, ctx: ExtensionContext, mode: string) => {
		await applyMode(targetPi, ctx, mode);
		return true;
	};
	(globalThis as any)[MODE_APPLY_BRIDGE] = applyBridge;

	pi.registerCommand("mode", {
		description: "Select and configure prompt modes",
		handler: async (args, ctx) => {
			const tokens = args.split(/\s+/).map((x) => x.trim()).filter(Boolean);

			if (tokens.length === 0) {
				await selectModeUI(pi, ctx);
				return;
			}

			if (tokens[0] === "configure") {
				await configureModesUI(pi, ctx);
				return;
			}

			if (tokens[0] === "store") {
				await ensureRuntime(pi, ctx);
				if (!runtime.overlayEnabled) {
					if (ctx.hasUI) ctx.ui.notify("Mode overlay is disabled; add a mode first in /mode configure", "warning");
					return;
				}

				let target: string | undefined = tokens[1];
				if (!target) {
					if (!ctx.hasUI) return;
					const names = orderedModeNames(runtime.data.modes);
					target = await ctx.ui.select("Store current selection into mode", names);
					if (!target) return;
				}

				if (target === CUSTOM_MODE_NAME) {
					if (ctx.hasUI) ctx.ui.notify(`Cannot store into "${CUSTOM_MODE_NAME}"`, "warning");
					return;
				}

				const selection = getCurrentSelectionSpec(pi, ctx);
				await storeSelectionIntoMode(pi, ctx, target, selection);
				if (ctx.hasUI) ctx.ui.notify(`Stored current selection into "${target}"`, "info");
				await syncModeFromCurrentSelection(pi, ctx);
				return;
			}

			await applyMode(pi, ctx, tokens[0]!);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Select prompt mode",
		handler: async (ctx) => {
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+s", {
		description: "Cycle prompt mode (deep → rush → smart)",
		handler: async (ctx) => {
			await cycleMode(pi, ctx, 1);
		},
	});

	pi.registerShortcut("alt+d", {
		description: "Cycle deep thinking level (deep → deep² → deep³)",
		handler: async (ctx) => {
			await cycleDeepThinkingLevel(pi, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		await ensureRuntime(pi, ctx);
		const appliedStartupMode = await applyStartupModeFlag(pi, ctx);
		if (!appliedStartupMode) await syncModeFromCurrentSelection(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		if ((globalThis as any)[MODE_APPLY_BRIDGE] === applyBridge) {
			delete (globalThis as any)[MODE_APPLY_BRIDGE];
		}
		clearPublishedMode(pi);
	});

	pi.on("model_select", async (event: any, ctx) => {
		lastObservedModel = { provider: event.model.provider, modelId: event.model.id };
		if (runtime.applying) return;
		await syncModeFromCurrentSelection(pi, ctx);
	});

	// A thinking-level change can flip the matched mode (modes are matched on
	// provider + modelId + thinkingLevel). When a mode is active AND the lock is
	// on, we keep thinking pinned to the mode's preset: shift+tab
	// (app.thinking.cycle) is a *reserved* keybinding that extensions can't
	// rebind, so we revert here in the event handler instead. If no mode is
	// active ("custom"), the model just changed, or the lock is off, we fall
	// through to re-matching (which may drop to "custom").
	pi.on("thinking_level_select", async (_event, ctx) => {
		if (runtime.applying || revertingThinking) return;
		await ensureRuntime(pi, ctx);
		if (!runtime.overlayEnabled) {
			publishMode(pi);
			return;
		}

		const mode = runtime.currentMode;
		if (mode === "" || mode === CUSTOM_MODE_NAME) {
			await syncModeFromCurrentSelection(pi, ctx);
			return;
		}

		const spec = runtime.data.modes[mode];
		// Mode didn't pin a thinking level — cycling thinking doesn't break its identity.
		if (!spec?.thinkingLevel) {
			await syncModeFromCurrentSelection(pi, ctx);
			return;
		}

		// If the underlying model changed (e.g. Ctrl+P), the mode is about to drop
		// to "custom" via model_select; don't fight a provider-driven thinking clamp.
		const selection = getCurrentSelectionSnapshot(pi, ctx);
		const modelChanged =
			!!spec.provider &&
			!!spec.modelId &&
			(spec.provider !== selection.provider || spec.modelId !== selection.modelId);

		const currentLevel = pi.getThinkingLevel() as ThinkingLevel;
		if (!modelChanged && isDefaultDeepSpec(mode, spec) && isDeepThinkingVariant(currentLevel)) {
			publishMode(pi);
			return;
		}

		if (runtime.lockThinkingWhenModeActive && !modelChanged && currentLevel !== spec.thinkingLevel) {
			revertingThinking = true;
			try {
				pi.setThinkingLevel(spec.thinkingLevel);
				// setThinkingLevel clamps to model capabilities — only claim a lock if
				// the preset actually took effect (otherwise let re-matching run).
				const after = pi.getThinkingLevel();
				if (after === spec.thinkingLevel) {
					publishMode(pi);
					if (ctx.hasUI) {
						ctx.ui.notify(`Thinking locked to "${mode}" (${spec.thinkingLevel}) — switch via /mode`, "info");
					}
					return;
				}
			} finally {
				revertingThinking = false;
			}
		}

		await syncModeFromCurrentSelection(pi, ctx);
	});

	// Catch non-model selection changes (e.g. thinking level tweaks from other paths)
	// before each agent run.
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncModeFromCurrentSelection(pi, ctx);
	});
}
