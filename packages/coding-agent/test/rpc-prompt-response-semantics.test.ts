import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	UNKNOWN_COMMAND_CONFIRM_HINT,
	UnknownCommandError,
	unknownCommandErrorFromWire,
} from "../src/core/unknown-command.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createAuthenticatedModelRegistry, createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	holdResponse?: boolean;
	responseDelayMs?: number;
	model?: Model<any>;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
	releaseResponse: () => void;
	streamStarted: Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}
	const streamStarted = Promise.withResolvers<void>();
	let releaseResponse = () => {};

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			const finish = () => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			if (options.holdResponse) releaseResponse = finish;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				streamStarted.resolve();
				if (!options.holdResponse) {
					if (options.responseDelayMs !== undefined) setTimeout(finish, options.responseDelayMs);
					else finish();
				}
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = options.withAuth
		? await createAuthenticatedModelRegistry(authStorage, tempDir)
		: await createModelRegistry(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		releaseResponse: () => releaseResponse(),
		streamStarted: streamStarted.promise,
		cleanup: async () => {
			try {
				await session.abort();
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	holdResponse?: boolean;
	responseDelayMs?: number;
	model?: Model<any>;
}): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
	releaseResponse: () => void;
	streamStarted: Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup, releaseResponse, streamStarted } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		cleanup,
		releaseResponse: () => releaseResponse(),
		streamStarted,
	};
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	// omo #9042 B: command-shaped prompt text that no command handles is refused before the model.
	it("refuses an unknown command with a typed unknown_command failure", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true });

		try {
			lineHandler(JSON.stringify({ id: "u1", type: "prompt", message: "/ulw-exec plan" }));

			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "u1")).toHaveLength(1));
			const [response] = getPromptResponses(rpcIo.outputLines, "u1");
			expect(response).toMatchObject({
				success: false,
				errorCode: "unknown_command",
				errorData: { command: "ulw-exec", suggestions: [], reason: "unknown" },
			});
			const rebuilt = unknownCommandErrorFromWire(response?.errorData);
			expect(rebuilt).toBeInstanceOf(UnknownCommandError);
			expect(response?.error).toBe(`${rebuilt?.message} ${UNKNOWN_COMMAND_CONFIRM_HINT}`);
			expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_start")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("refuses an interactive-only builtin sent as a prompt", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true });

		try {
			lineHandler(JSON.stringify({ id: "u2", type: "prompt", message: "/model claude" }));

			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "u2")).toHaveLength(1));
			expect(getPromptResponses(rpcIo.outputLines, "u2")[0]).toMatchObject({
				success: false,
				errorCode: "unknown_command",
				error: `/model is an interactive command and cannot be sent as a prompt. ${UNKNOWN_COMMAND_CONFIRM_HINT}`,
				errorData: { command: "model", reason: "interactive_only" },
			});
		} finally {
			await cleanup();
		}
	});

	it("sends unknown command text when the prompt opts in", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true });

		try {
			lineHandler(JSON.stringify({ id: "u3", type: "prompt", message: "/foo bar", unknownCommandAsText: true }));

			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "u3")).toHaveLength(1));
			expect(getPromptResponses(rpcIo.outputLines, "u3")[0]).toMatchObject({ success: true });
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, holdResponse: true });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("acks abort while the session is still streaming", async () => {
		const { lineHandler, cleanup, releaseResponse, streamStarted } = await startRpcMode({
			withAuth: true,
			holdResponse: true,
		});

		try {
			lineHandler(JSON.stringify({ id: "abort-start", type: "prompt", message: "Hold this" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "abort-start")).toHaveLength(1);
			});
			await streamStarted;

			lineHandler(JSON.stringify({ id: "abort-1", type: "abort" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "abort-1",
					type: "response",
					command: "abort",
					success: true,
				});
			});
			const records = parseOutputLines(rpcIo.outputLines);
			const abortResponseIndex = records.findIndex((record) => record.id === "abort-1");
			const agentEndIndex = records.findIndex((record) => record.type === "agent_end");
			expect(abortResponseIndex).toBeGreaterThanOrEqual(0);
			expect(agentEndIndex).toBeGreaterThanOrEqual(0);
			expect(abortResponseIndex).toBeLessThan(agentEndIndex);
		} finally {
			releaseResponse();
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
						ordered: [
							{ text: "Change direction", mode: "steer", enqueueOrder: expect.any(Number) },
							{ text: "Summarize when finished", mode: "followUp", enqueueOrder: expect.any(Number) },
						],
					},
				});
			});

			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_end")).toHaveLength(1);
			});
		} finally {
			await cleanup();
		}
	});
});
