import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildPromptBlocks,
	buildPromptStream,
} from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import { dedupeUltraworkBlocks } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-directive-dedupe.ts";

type CapturedBlock = { type: string; text?: string; cache_control?: unknown };
type CapturedRequest = {
	system?: CapturedBlock[];
	messages: { role: string; content: string | CapturedBlock[] }[];
};

const sse = (events: [string, unknown][]): string =>
	events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const END_TURN = sse([
	[
		"message_start",
		{
			type: "message_start",
			message: {
				id: "msg_capture",
				type: "message",
				role: "assistant",
				model: "mock",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		},
	],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	],
	["message_stop", { type: "message_stop" }],
]);

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolLoop(rounds: number): Message[] {
	const messages: Message[] = [{ role: "user", content: "fix the bug", timestamp: 1 }];
	for (let round = 1; round <= rounds; round++) {
		messages.push(
			assistant(
				[{ type: "toolCall", id: `call-${round}`, name: "read", arguments: { path: `f${round}.ts` } }],
				round,
			),
			{
				role: "toolResult",
				toolCallId: `call-${round}`,
				toolName: "read",
				content: [{ type: "text", text: `contents of f${round}.ts` }],
				isError: false,
				timestamp: round,
			},
		);
	}
	return messages;
}

function breakpoints(request: CapturedRequest): number {
	const blocks = [
		...(request.system ?? []),
		...request.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
	];
	return blocks.filter((block) => block.cache_control !== undefined).length;
}

function firstUserBlocks(request: CapturedRequest): CapturedBlock[] {
	const content = request.messages[0]?.content;
	return Array.isArray(content) ? content : [];
}

function stripped(block: CapturedBlock): CapturedBlock {
	const { cache_control: _cacheControl, ...rest } = block;
	return rest;
}

async function captureTurns(turns: Message[][]): Promise<CapturedRequest[]> {
	const bodies: string[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (
				request.method === "POST" &&
				request.url?.startsWith("/v1/messages") &&
				!request.url.includes("count_tokens")
			) {
				bodies.push(body);
				response.writeHead(200, { "content-type": "text/event-stream" }).end(END_TURN);
				return;
			}
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
	});
	const directory = await mkdtemp(join(tmpdir(), "senpi-2982-capture-"));
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		for (const messages of turns) {
			const blocks = dedupeUltraworkBlocks(
				buildPromptBlocks({ messages }, undefined, undefined, { cacheBreakpoint: true }),
			).blocks;
			const stream = query({
				prompt: buildPromptStream(blocks),
				options: {
					cwd: directory,
					model: "opus",
					permissionMode: "dontAsk",
					settingSources: [],
					maxTurns: 1,
					env: {
						PATH: process.env.PATH ?? "",
						TMPDIR: directory,
						HOME: join(directory, "home"),
						CLAUDE_CONFIG_DIR: join(directory, "claude-config"),
						ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
						ANTHROPIC_API_KEY: "capture-probe-key",
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
					},
				},
			});
			for await (const message of stream) {
				if (message.type === "result") break;
			}
		}
		return bodies.map((body) => JSON.parse(body) as CapturedRequest);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
}

describe("senpi#2982 the installed Claude Code sends a rebuilt prompt as a cacheable prefix", () => {
	it("forwards the history breakpoint and repeats the previous turn's bytes up to it", async () => {
		// given two consecutive turns of a tool loop rebuilt the way resumeMode off sends them
		// when the installed Claude Code sends both to a local endpoint
		const [first, second] = await captureTurns([toolLoop(1), toolLoop(2)]);
		if (first === undefined || second === undefined) throw new Error("expected two provider requests");

		// then each request carries our breakpoint without exceeding the API's four
		const firstBlocks = firstUserBlocks(first);
		const firstBreakpoint = firstBlocks.findIndex((block) => block.cache_control !== undefined);
		expect(firstBreakpoint).toBeGreaterThan(0);
		expect(firstBlocks[firstBreakpoint + 1]?.text).toBe("\n</conversation_history>");
		expect(breakpoints(first)).toBeLessThanOrEqual(4);
		expect(breakpoints(second)).toBeLessThanOrEqual(4);

		// and the second request starts with the first one's bytes through that breakpoint
		expect(
			firstUserBlocks(second)
				.slice(0, firstBreakpoint + 1)
				.map(stripped),
		).toEqual(firstBlocks.slice(0, firstBreakpoint + 1).map(stripped));
	}, 60_000);
});
