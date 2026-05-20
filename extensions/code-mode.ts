import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getSettingsListTheme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const TOOL_NAME = "exec";
const COMMAND_NAME = "codeMode";
const DEFAULT_TIMEOUT_MS = 30_000;
const TOOL_CALL_PREVIEW_LIMIT = 1_000;
type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";
const BUILT_IN_TOOL_NAMES: ToolName[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];

const CONFIG_DIR = join(homedir(), ".pi-codemode");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const CodeModeParams = Type.Object({
	code: Type.String({
		description:
			"JavaScript async arrow function to execute, for example: async () => { const files = await codemode.ls({ path: '.' }); return files; }",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Maximum execution time in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
		}),
	),
});

type CodeModeParams = Static<typeof CodeModeParams>;
type BuiltInToolDefinitions = Record<ToolName, ToolDefinition<any, any, any>>;

/**
 * Persisted Code Mode configuration. Lives at ~/.pi-codemode/config.json and is
 * edited interactively through the /codeMode command.
 */
interface CodeModeConfig {
	/** When true, the exec tool is exposed and built-in tools are hidden from the model. */
	enabled: boolean;
	/** Which built-in tools exec is allowed to orchestrate. */
	tools: Record<ToolName, boolean>;
}

/** Current config, reloaded from disk on every session_start. */
let config: CodeModeConfig = { enabled: true, tools: defaultTools(new Set(BUILT_IN_TOOL_NAMES)) };
/** Built-in tools that Pi had active at session startup. Used to restore them when Code Mode is turned off. */
let startupBuiltIns = new Set<ToolName>();
/** registerCommand is idempotent per process; session_start can fire repeatedly. */
let commandRegistered = false;

interface LogEntry {
	level: "log" | "info" | "warn" | "error";
	args: unknown[];
}

interface ToolCallSummary {
	id: number;
	tool: string;
	params: unknown;
	ok?: boolean;
	durationMs?: number;
	error?: string;
	preview?: string;
}

interface CodeModeDetails {
	result?: unknown;
	logs: LogEntry[];
	calls: ToolCallSummary[];
	durationMs: number;
	timedOut: boolean;
	error?: string;
}

type WorkerToHostMessage =
	| { type: "log"; level: LogEntry["level"]; args: unknown[] }
	| { type: "toolCall"; id: number; toolName: string; params: unknown }
	| { type: "result"; value: unknown }
	| { type: "error"; error: SerializedError };

type HostToWorkerMessage =
	| { type: "toolResult"; id: number; ok: true; value: unknown }
	| { type: "toolResult"; id: number; ok: false; error: SerializedError };

interface SerializedError {
	name?: string;
	message: string;
	stack?: string;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const pending = new Map();
let nextToolCallId = 1;

function serializeError(error) {
	if (error && typeof error === "object") {
		return {
			name: typeof error.name === "string" ? error.name : undefined,
			message: typeof error.message === "string" ? error.message : String(error),
			stack: typeof error.stack === "string" ? error.stack : undefined,
		};
	}

	return { message: String(error) };
}

function makeConsole(level) {
	return (...args) => {
		parentPort.postMessage({ type: "log", level, args });
	};
}

function callTool(toolName, params) {
	const id = nextToolCallId++;
	parentPort.postMessage({ type: "toolCall", id, toolName, params });

	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
	});
}

parentPort.on("message", (message) => {
	if (!message || message.type !== "toolResult") return;

	const request = pending.get(message.id);
	if (!request) return;
	pending.delete(message.id);

	if (message.ok) {
		request.resolve(message.value);
	} else {
		const error = new Error(message.error?.message || "Tool call failed");
		if (message.error?.name) error.name = message.error.name;
		if (message.error?.stack) error.stack = message.error.stack;
		request.reject(error);
	}
});

const toolMap = new Map(Object.entries(workerData.toolMap));
const codemode = Object.freeze(
	Object.fromEntries(
		[...toolMap.entries()].map(([methodName, toolName]) => [
			methodName,
			(params) => callTool(toolName, params),
		]),
	),
);

const context = vm.createContext({
	codemode,
	console: Object.freeze({
		log: makeConsole("log"),
		info: makeConsole("info"),
		warn: makeConsole("warn"),
		error: makeConsole("error"),
	}),
	AbortController,
	AbortSignal,
	Array,
	Boolean,
	Date,
	Error,
	JSON,
	Math,
	Number,
	Object,
	Promise,
	RegExp,
	Set,
	String,
	URL,
	URLSearchParams,
});

(async () => {
	try {
		const script = new vm.Script(
			'"use strict";\nconst __codeModeFn = (' + workerData.code + ');\nif (typeof __codeModeFn !== "function") { throw new TypeError("code must evaluate to a function"); }\n__codeModeFn();',
			{
				filename: "code-mode-input.js",
				displayErrors: true,
				timeout: workerData.syncTimeoutMs,
			},
		);

		const value = await script.runInContext(context, {
			timeout: workerData.syncTimeoutMs,
			displayErrors: true,
		});

		parentPort.postMessage({ type: "result", value });
	} catch (error) {
		parentPort.postMessage({ type: "error", error: serializeError(error) });
	}
})();
`;

function serializeError(error: unknown): SerializedError {
	if (error && typeof error === "object") {
		const maybeError = error as { name?: unknown; message?: unknown; stack?: unknown };
		return {
			name: typeof maybeError.name === "string" ? maybeError.name : undefined,
			message: typeof maybeError.message === "string" ? maybeError.message : String(error),
			stack: typeof maybeError.stack === "string" ? maybeError.stack : undefined,
		};
	}

	return { message: String(error) };
}

function errorMessage(error: unknown): string {
	return serializeError(error).message;
}

function toJsonSafe(value: unknown): unknown {
	const seen = new WeakSet<object>();

	return JSON.parse(
		JSON.stringify(value, (_key, item) => {
			if (typeof item === "bigint") {
				return item.toString();
			}

			if (item instanceof Error) {
				return serializeError(item);
			}

			if (Buffer.isBuffer(item)) {
				return `[Buffer ${item.length} bytes]`;
			}

			if (item && typeof item === "object") {
				if (seen.has(item)) {
					return "[Circular]";
				}
				seen.add(item);
			}

			return item;
		}) ?? "null",
	);
}

function preview(value: unknown): string {
	const text = JSON.stringify(toJsonSafe(value));
	if (text.length <= TOOL_CALL_PREVIEW_LIMIT) return text;
	return `${text.slice(0, TOOL_CALL_PREVIEW_LIMIT)}...`;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
		return DEFAULT_TIMEOUT_MS;
	}

	return Math.min(Math.max(Math.trunc(timeoutMs), 1_000), 120_000);
}

function methodNameForTool(toolName: string): string {
	const sanitized = toolName.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

/** Build every built-in tool definition. exec executes these directly, so they
 *  stay available even after the tools are hidden from the model. */
function createAllBuiltInDefinitions(cwd: string): BuiltInToolDefinitions {
	return {
		read: createReadToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

function buildToolMap(): Record<string, string> {
	const toolMap: Record<string, string> = {};
	for (const name of BUILT_IN_TOOL_NAMES) {
		toolMap[methodNameForTool(name)] = name;
	}
	return toolMap;
}

function formatValidationErrors(schema: TSchema, params: unknown): string {
	const errors = [...Value.Errors(schema, params)].map((error) => {
		const path = error.instancePath || "/";
		return `${path}: ${error.message}`;
	});

	return errors.length > 0 ? errors.join("; ") : "invalid parameters";
}

async function executeBuiltInTool(
	toolCallId: string,
	definition: ToolDefinition<any, any, any>,
	params: unknown,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<unknown> {
	const prepared = definition.prepareArguments ? definition.prepareArguments(params) : params;

	if (!Value.Check(definition.parameters, prepared)) {
		throw new Error(`Invalid params for ${definition.name}: ${formatValidationErrors(definition.parameters, prepared)}`);
	}

	const result = await definition.execute(toolCallId, prepared, signal, undefined, ctx);
	return toJsonSafe(result);
}

function schemaToType(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "unknown";

	const typed = schema as {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
		items?: unknown;
		anyOf?: unknown[];
		oneOf?: unknown[];
		enum?: unknown[];
		const?: unknown;
	};

	if (Array.isArray(typed.enum)) {
		return typed.enum.map((item) => JSON.stringify(item)).join(" | ");
	}

	if ("const" in typed) {
		return JSON.stringify(typed.const);
	}

	if (Array.isArray(typed.anyOf)) {
		return typed.anyOf.map(schemaToType).join(" | ");
	}

	if (Array.isArray(typed.oneOf)) {
		return typed.oneOf.map(schemaToType).join(" | ");
	}

	switch (typed.type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "array":
			return `${schemaToType(typed.items)}[]`;
		case "object": {
			const properties = typed.properties ?? {};
			const required = new Set(typed.required ?? []);
			const entries = Object.entries(properties).map(([name, value]) => {
				const propertyName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
				return `${propertyName}${required.has(name) ? "" : "?"}: ${schemaToType(value)}`;
			});

			return entries.length > 0 ? `{ ${entries.join("; ")} }` : "Record<string, unknown>";
		}
		default:
			return "unknown";
	}
}

/** The codemode API declaration always lists all built-in tools. Whether a tool
 *  is currently orchestrable is governed at runtime by the /codeMode config, so
 *  the static tool description never drifts out of sync. */
function buildCodeModeDeclaration(definitions: BuiltInToolDefinitions): string {
	const lines = BUILT_IN_TOOL_NAMES.map((name) => {
		const methodName = methodNameForTool(name);
		return `  ${methodName}(input: ${schemaToType(definitions[name].parameters)}): Promise<PiToolResult>;`;
	});

	return [
		"Available codemode API:",
		"```ts",
		"type PiToolResult = { content: unknown[]; details?: unknown };",
		"declare const codemode: {",
		...lines,
		"};",
		"```",
	].join("\n");
}

function buildDescription(cwd: string): string {
	const declaration = buildCodeModeDeclaration(createAllBuiltInDefinitions(cwd));

	return [
		"Execute a JavaScript async arrow function that orchestrates Pi built-in tools.",
		"Provide code as a function, not a script body. Return the final value.",
		"Use only codemode.<tool>(input) for side effects and inspection.",
		"Individual tools can be disabled with the /codeMode command; calling a disabled tool fails that call with an error reported in the calls summary.",
		declaration,
		"Example: async () => { const root = await codemode.ls({ path: '.' }); console.log(root); return root; }",
	].join("\n\n");
}

function defaultTools(active: Set<ToolName>): Record<ToolName, boolean> {
	const tools = {} as Record<ToolName, boolean>;
	for (const name of BUILT_IN_TOOL_NAMES) {
		tools[name] = active.has(name);
	}
	return tools;
}

/** Load config from disk, falling back to the session's startup tool state for
 *  any field that is missing or malformed. */
function loadConfig(startupActive: Set<ToolName>): CodeModeConfig {
	let saved: { enabled?: unknown; tools?: Record<string, unknown> } | null = null;
	try {
		saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		saved = null;
	}

	const tools = {} as Record<ToolName, boolean>;
	for (const name of BUILT_IN_TOOL_NAMES) {
		const savedValue = saved?.tools?.[name];
		tools[name] = typeof savedValue === "boolean" ? savedValue : startupActive.has(name);
	}

	return {
		enabled: typeof saved?.enabled === "boolean" ? saved.enabled : true,
		tools,
	};
}

function saveConfig(): void {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	} catch {
		// Persisting config is best-effort; a read-only home directory should not break the session.
	}
}

/**
 * Reconcile Pi's model-facing tool list with the current config.
 *  - enabled:  hide every built-in tool from the model, expose exec.
 *  - disabled: restore the built-in tools Pi had at startup, hide exec.
 * exec keeps orchestrating its own built-in definitions regardless.
 */
function applyState(pi: ExtensionAPI): void {
	const active = new Set(pi.getActiveTools());

	if (config.enabled) {
		for (const name of BUILT_IN_TOOL_NAMES) {
			active.delete(name);
		}
		active.add(TOOL_NAME);
	} else {
		for (const name of startupBuiltIns) {
			active.add(name);
		}
		active.delete(TOOL_NAME);
	}

	pi.setActiveTools([...active]);
}

async function runCodeMode(
	params: CodeModeParams,
	ctx: ExtensionContext,
	toolDefinitions: BuiltInToolDefinitions,
	enabledTools: Set<ToolName>,
	parentToolCallId: string,
	signal: AbortSignal | undefined,
): Promise<CodeModeDetails> {
	const timeoutMs = normalizeTimeout(params.timeoutMs);
	const toolMap = buildToolMap();
	const logs: LogEntry[] = [];
	const calls: ToolCallSummary[] = [];
	const startedAt = Date.now();
	const runAbort = new AbortController();
	const effectiveSignal = runAbort.signal;

	if (signal) {
		if (signal.aborted) {
			runAbort.abort(signal.reason);
		} else {
			signal.addEventListener("abort", () => runAbort.abort(signal.reason), { once: true });
		}
	}

	return await new Promise<CodeModeDetails>((resolve) => {
		let settled = false;
		let timedOut = false;
		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: {
				code: params.code,
				toolMap,
				syncTimeoutMs: Math.min(timeoutMs, 1_000),
			},
		});

		const settle = async (details: Omit<CodeModeDetails, "durationMs" | "logs" | "calls" | "timedOut">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			runAbort.abort();

			if (!timedOut) {
				await worker.terminate().catch(() => undefined);
			}

			resolve({
				...details,
				logs,
				calls,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		};

		const timer = setTimeout(() => {
			timedOut = true;
			runAbort.abort(new Error(`exec timed out after ${timeoutMs}ms`));
			void worker.terminate().finally(() => {
				void settle({ error: `exec timed out after ${timeoutMs}ms` });
			});
		}, timeoutMs);

		worker.on("message", (message: WorkerToHostMessage) => {
			if (!message || settled) return;

			if (message.type === "log") {
				logs.push({
					level: message.level,
					args: toJsonSafe(message.args) as unknown[],
				});
				return;
			}

			if (message.type === "result") {
				void settle({ result: toJsonSafe(message.value) });
				return;
			}

			if (message.type === "error") {
				void settle({ error: message.error.message });
				return;
			}

			if (message.type === "toolCall") {
				const callStartedAt = Date.now();
				const summary: ToolCallSummary = {
					id: message.id,
					tool: message.toolName,
					params: toJsonSafe(message.params),
				};
				calls.push(summary);

				const failCall = (errorText: string) => {
					const error = serializeError(new Error(errorText));
					summary.ok = false;
					summary.error = error.message;
					summary.durationMs = Date.now() - callStartedAt;
					worker.postMessage({ type: "toolResult", id: message.id, ok: false, error } satisfies HostToWorkerMessage);
				};

				if (!enabledTools.has(message.toolName as ToolName)) {
					failCall(`Tool '${message.toolName}' is disabled for Code Mode. Enable it with the /${COMMAND_NAME} command.`);
					return;
				}

				const definition = toolDefinitions[message.toolName as ToolName];
				if (!definition) {
					failCall(`Tool is not available to exec: ${message.toolName}`);
					return;
				}

				void executeBuiltInTool(
					`${parentToolCallId}:${message.id}:${message.toolName}`,
					definition,
					message.params,
					effectiveSignal,
					ctx,
				)
					.then((value) => {
						summary.ok = true;
						summary.durationMs = Date.now() - callStartedAt;
						summary.preview = preview(value);
						if (!settled) {
							worker.postMessage({
								type: "toolResult",
								id: message.id,
								ok: true,
								value,
							} satisfies HostToWorkerMessage);
						}
					})
					.catch((error: unknown) => {
						const serialized = serializeError(error);
						summary.ok = false;
						summary.error = serialized.message;
						summary.durationMs = Date.now() - callStartedAt;
						if (!settled) {
							worker.postMessage({
								type: "toolResult",
								id: message.id,
								ok: false,
								error: serialized,
							} satisfies HostToWorkerMessage);
						}
					});
			}
		});

		worker.on("error", (error) => {
			void settle({ error: errorMessage(error) });
		});

		worker.on("exit", (code) => {
			if (!settled && !timedOut && code !== 0) {
				void settle({ error: `exec worker exited with code ${code}` });
			}
		});
	});
}

function buildCodeModeTool(ctx: ExtensionContext) {
	return defineTool({
		name: TOOL_NAME,
		label: "Exec",
		description: buildDescription(ctx.cwd),
		promptSnippet: "Run JavaScript to orchestrate Pi built-in tools with loops, conditionals, and composed results.",
		promptGuidelines: [
			"Use exec for multi-step tool orchestration that benefits from loops, conditionals, or structured post-processing.",
			"Pass an async arrow function as code, call only codemode.<tool>(input), and return the final value.",
			"Use ordinary Pi tools directly for simple one-step work.",
			"Do not write infinite loops; exec has a timeout and returns logs, calls, and result details.",
		],
		parameters: CodeModeParams,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, executionCtx) {
			const activeCtx = executionCtx ?? ctx;

			if (!config.enabled) {
				const error = `Code Mode is disabled. Enable it with the /${COMMAND_NAME} command.`;
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error }, null, 2) }],
					details: { logs: [], calls: [], durationMs: 0, timedOut: false, error } satisfies CodeModeDetails,
				};
			}

			const allTools = createAllBuiltInDefinitions(activeCtx.cwd);
			const enabledTools = new Set(BUILT_IN_TOOL_NAMES.filter((name) => config.tools[name]));
			const details = await runCodeMode(params, activeCtx, allTools, enabledTools, toolCallId, signal);

			const summary = {
				ok: !details.error,
				result: details.result,
				error: details.error,
				logs: details.logs,
				calls: details.calls,
				durationMs: details.durationMs,
				timedOut: details.timedOut,
			};

			return {
				content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
				details,
			};
		},
	});
}

/** Open the interactive /codeMode settings overlay. Space cycles each row's value. */
async function openCodeModeSettings(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, done) => {
			const items: SettingItem[] = [
				{
					id: "__enabled",
					label: "Code Mode",
					description: "When enabled, exec is exposed to the model and the built-in tools are hidden behind it.",
					currentValue: config.enabled ? "enabled" : "disabled",
					values: ["disabled", "enabled"],
				},
				...BUILT_IN_TOOL_NAMES.map(
					(name): SettingItem => ({
						id: name,
						label: `tool: ${name}`,
						description: `Allow exec to orchestrate the ${name} tool.`,
						currentValue: config.tools[name] ? "on" : "off",
						values: ["off", "on"],
					}),
				),
			];

			return new SettingsList(
				items,
				12,
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "__enabled") {
						config.enabled = newValue === "enabled";
					} else {
						config.tools[id as ToolName] = newValue === "on";
					}
					saveConfig();
					applyState(pi);
				},
				() => done(),
			);
		},
		{ overlay: true },
	);
}

export default function codeModeExtension(pi: ExtensionAPI) {
	// Per-session: the startup tool snapshot must be captured before applyState
	// first hides the built-in tools, and the built-ins are not yet populated in
	// getActiveTools() at session_start — so initialization is deferred to the
	// first agent_start of each session.
	let initialized = false;

	pi.on("session_start", (_event, ctx) => {
		initialized = false;
		pi.registerTool(buildCodeModeTool(ctx));

		if (!commandRegistered) {
			pi.registerCommand(COMMAND_NAME, {
				description: "Configure Code Mode: toggle it on/off and pick which tools exec can orchestrate.",
				handler: async (_args, commandCtx) => {
					if (!commandCtx.hasUI) {
						commandCtx.ui.notify(`/${COMMAND_NAME} needs an interactive terminal.`, "warning");
						return;
					}
					await openCodeModeSettings(pi, commandCtx);
				},
			});
			commandRegistered = true;
		}
	});

	// Re-assert the tool list each turn so a manual `pi config` change cannot
	// silently re-expose the built-in tools while Code Mode is on.
	pi.on("agent_start", () => {
		if (!initialized) {
			const active = pi.getActiveTools();
			startupBuiltIns = new Set(BUILT_IN_TOOL_NAMES.filter((name) => active.includes(name)));
			config = loadConfig(startupBuiltIns);
			initialized = true;
		}
		applyState(pi);
	});
}
