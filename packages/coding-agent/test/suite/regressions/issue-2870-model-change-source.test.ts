import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2870: a mid-session model switch was recorded with no source, so a switch nobody remembered making could not
// be attributed; and every terminal selection silently rewrote the global defaultModel for every later session.

const MODELS = [
	{ id: "main", name: "Main", reasoning: true },
	{ id: "other", name: "Other", reasoning: true },
];

function modelChanges(harness: Harness): ModelChangeEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is ModelChangeEntry => entry.type === "model_change");
}

function other(harness: Harness) {
	const model = harness.getModel("other");
	if (model === undefined) throw new Error("missing fixture model");
	return model;
}

describe("issue 2870: every model switch records its source", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("an SDK setModel names sdk and still persists the default, as its contract says", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);

		await harness.session.setModel(other(harness));

		expect(modelChanges(harness).map(({ source, actor }) => ({ source, actor }))).toEqual([
			{ source: "sdk", actor: undefined },
		]);
		expect(harness.settingsManager.getDefaultModel()).toBe("other");
	});

	it("a picker selection records picker and its actor, and leaves the default for new sessions alone", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const before = harness.settingsManager.getDefaultModel();

		await harness.session.setSessionModel(other(harness), { source: "picker", actor: "model-selector" });

		const [entry] = modelChanges(harness);
		expect(entry).toMatchObject({ source: "picker", actor: "model-selector", originalModelId: "main" });
		expect(entry?.duringTurn).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBe(before);
		expect(harness.eventsOfType("model_changed").at(-1)).toMatchObject({
			origin: { source: "picker", actor: "model-selector" },
			duringTurn: false,
		});
	});

	it("a terminal cycle that asks not to persist records cycle and leaves the default alone", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: other(harness) }]);
		const before = harness.settingsManager.getDefaultModel();

		await harness.session.cycleModel("forward", { persistDefault: false });

		expect(harness.session.model?.id).toBe("other");
		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "cycle" });
		expect(harness.settingsManager.getDefaultModel()).toBe(before);
	});

	it("an RPC cycle keeps persisting the default and records its own source", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: other(harness) }]);

		await harness.session.cycleModel("forward", { origin: { source: "rpc", actor: "cycle_model" } });

		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "rpc", actor: "cycle_model" });
		expect(harness.settingsManager.getDefaultModel()).toBe("other");
	});

	it("an extension's switch names the extension that made it", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: MODELS,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		if (api === undefined) throw new Error("extension was not loaded");

		await api.setSessionModel(other(harness));

		const [entry] = modelChanges(harness);
		expect(entry?.source).toBe("extension");
		expect(typeof entry?.actor).toBe("string");
		expect(entry?.actor?.length).toBeGreaterThan(0);
	});

	it("a switch made during a streaming turn is marked as such, with its thinking re-apply attributed too", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Runs until released",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await released.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ models: MODELS, tools: [hold] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		harness.session.setThinkingLevel("low");
		const turn = harness.session.prompt("go");
		await toolStarted.promise;

		await harness.session.setSessionModel(other(harness), { source: "control" });
		released.resolve();
		await turn;

		expect(modelChanges(harness).at(-1)).toMatchObject({
			source: "control",
			duringTurn: true,
			originalModelId: "main",
		});
		const thinking = harness.sessionManager
			.getEntries()
			.filter((entry): entry is ThinkingLevelChangeEntry => entry.type === "thinking_level_change")
			.filter((entry) => entry.triggerSource !== undefined);
		expect(thinking.every((entry) => entry.triggerSource === "control")).toBe(true);
		expect(harness.eventsOfType("model_changed").at(-1)).toMatchObject({ duringTurn: true });
	});

	it("writes one session-log line per switch with the source and the models", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);

		await harness.session.setSessionModel(other(harness), { source: "rpc" });

		const log = join(harness.session.agentDir, "logs", "session.log");
		expect(existsSync(log)).toBe(true);
		const lines = readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line.includes("model_change"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("rpc");
		expect(lines[0]).toContain("/other");
		expect(lines[0]).toContain("/main");
	});
});
