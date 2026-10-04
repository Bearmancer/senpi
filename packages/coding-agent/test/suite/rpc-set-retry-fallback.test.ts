import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	applyRetryFallbackProfile,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";

// A task child spawned as its own `--mode rpc` process gets its category's fallback chain over the wire
// (omo#9582): no open_session there, and never through the user's settings file.

const USAGE_LIMIT = "You've hit your session limit · resets 3pm";
const USER_SETTINGS = { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 }, defaultThinkingLevel: "off" };
const CHILD_CHAIN = { modelFallback: true, fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare"] } };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface SingleProcess {
	readonly runtime: AgentSessionRuntime;
	readonly settingsPath: string;
	request(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	lastAssistantText(): string;
}

async function singleRpcProcess(options: { retryFallbackCommand: boolean }): Promise<SingleProcess> {
	const dir = join(tmpdir(), `senpi-set-retry-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const settingsPath = join(dir, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);

	const faux = registerFauxProvider({
		api: "faux-fallback",
		provider: "faux-fallback",
		models: [{ id: "primary" }, { id: "spare" }],
	});
	const step: FauxResponseStep = (_context, _options, _state, model) =>
		model.id === "primary"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT })
			: fauxAssistantMessage(`answered by ${model.id}`);
	faux.setResponses(Array.from({ length: 12 }, () => step));
	const auth = AuthStorage.inMemory();
	await auth.modify("faux-fallback", async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: join(dir, "models.json") });
	modelRuntime.registerProvider("faux-fallback", {
		baseUrl: faux.models[0].baseUrl,
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	const primary = faux.getModel("primary");
	if (primary === undefined) throw new Error("faux primary model missing");

	// The same launch-profile step the CLI runtime factory takes (main.ts createServices).
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		sessionManager,
		sessionStartEvent,
		launchProfile,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: dir,
			modelRuntime,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		if (launchProfile?.retryFallback)
			applyRetryFallbackProfile(services.settingsManager, launchProfile.retryFallback);
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: primary })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: SessionManager.create(dir),
	});
	await runtime.session.bindExtensions({});

	const lines: Record<string, unknown>[] = [];
	const waiters = new Map<string, (line: Record<string, unknown>) => void>();
	const handler: RpcConnectionHandler = createRpcConnectionHandler(
		runtime,
		{
			writeRaw(chunk) {
				for (const text of chunk.split("\n")) {
					if (text.length === 0) continue;
					const line = JSON.parse(text) as Record<string, unknown>;
					lines.push(line);
					if (line.type === "response" && typeof line.id === "string") waiters.get(line.id)?.(line);
				}
			},
			waitForBackpressure: async () => {},
		},
		{ retryFallbackCommand: options.retryFallbackCommand },
	);
	await handler.ready;
	cleanups.push(async () => {
		await handler.dispose();
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});

	let sequence = 0;
	return {
		runtime,
		settingsPath,
		async request(command) {
			const id = `req-${++sequence}`;
			const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no response to ${String(command.type)}`)), 20_000);
				waiters.set(id, (line) => {
					clearTimeout(timer);
					resolve(line);
				});
			});
			await handler.handleInputLine(JSON.stringify({ ...command, id }));
			const response = await answered;
			if (command.type === "prompt") await runtime.session.waitForIdle();
			return response;
		},
		lastAssistantText() {
			const assistant = runtime.session.messages.filter((message) => message.role === "assistant").at(-1) as
				| { content?: Array<{ type: string; text?: string }>; errorMessage?: string }
				| undefined;
			return (
				assistant?.content?.find((block) => block.type === "text" && block.text)?.text ??
				assistant?.errorMessage ??
				""
			);
		},
	};
}

it("#given a single-process child told its chain before its first turn #when its model hits a usage limit #then it answers on the fallback and the settings file is untouched", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	const settingsBefore = readFileSync(child.settingsPath);
	const info = await child.request({ type: "get_protocol_info" });
	expect((info.data as { capabilities: string[] }).capabilities).toContain("retry_fallback_command");
	const set = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	expect(set.success, String(set.error)).toBe(true);

	// when
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(child.lastAssistantText()).toBe("answered by spare");
	expect(readFileSync(child.settingsPath)).toEqual(settingsBefore);
}, 60_000);

it("#given a single-process child never told a chain #when its model hits a usage limit #then it fails cleanly with the limit, as before", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });

	// when
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(child.lastAssistantText()).toContain("session limit");
}, 60_000);

it("#given a child that has already run a turn #when a chain arrives #then it is refused and the chain it runs with does not change", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	await child.request({ type: "prompt", message: "go" });

	// when
	const late = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });

	// then
	expect(late.success).toBe(false);
	expect(String(late.error)).toContain("before the session's first turn");
	expect(child.runtime.session.settingsManager.getRetryFallbackSettings().chains).not.toHaveProperty(
		"faux-fallback/primary",
	);
}, 60_000);

it("#given a child told its chain #when it moves to a replacement session #then the replacement keeps the chain", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });

	// when
	const replaced = await child.runtime.newSession();
	await child.runtime.session.bindExtensions({});

	// then
	expect(replaced.cancelled).toBe(false);
	expect(child.runtime.session.settingsManager.getRetryFallbackSettings().chains).toMatchObject({
		"faux-fallback/primary": ["faux-fallback/spare"],
	});
}, 60_000);

it("#given a malformed chain #when it is sent #then it is refused with the open_session shape rule and nothing is applied", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });

	// when
	const bad = await child.request({
		type: "set_retry_fallback",
		retryFallback: { fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare"] } },
	});

	// then
	expect(bad.success).toBe(false);
	expect(String(bad.error)).toContain("retryFallback must be");
	expect(child.runtime.session.settingsManager.getRetryFallbackSettings().chains).not.toHaveProperty(
		"faux-fallback/primary",
	);
}, 60_000);

it("#given a host session connection #when a chain arrives over set_retry_fallback #then it is refused and the capability is not advertised", async () => {
	// given
	const hosted = await singleRpcProcess({ retryFallbackCommand: false });

	// when
	const info = await hosted.request({ type: "get_protocol_info" });
	const set = await hosted.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });

	// then
	expect((info.data as { capabilities: string[] }).capabilities).not.toContain("retry_fallback_command");
	expect(set.success).toBe(false);
	expect(String(set.error)).toContain("open_session.retryFallback");
}, 60_000);
