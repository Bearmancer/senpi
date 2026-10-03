import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { z } from "zod";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

const USAGE_LIMIT = "You've hit your session limit · resets 3pm";
const USER_SETTINGS = { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 }, defaultThinkingLevel: "off" };

function fauxWherePrimaryIsAtItsUsageLimit() {
	const faux = fauxProvider({
		api: "faux-fallback",
		provider: "faux-fallback",
		models: [{ id: "primary" }, { id: "spare-a" }, { id: "spare-b" }],
	});
	const step: FauxResponseStep = (_context, _options, _state, model) =>
		model.id === "primary"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT })
			: fauxAssistantMessage(`answered by ${model.id}`);
	faux.setResponses(Array.from({ length: 12 }, () => step));
	return faux;
}

function lastAssistantText(host: Awaited<ReturnType<typeof contextHost>>, sessionId: string): string {
	const records = host.inbox("conn-a").concat(host.inbox("conn-b"));
	const ends = records.filter(
		(record) =>
			record.type === "message_end" &&
			record.sessionId === sessionId &&
			(record as { message?: { role?: string } }).message?.role === "assistant",
	);
	const message = (
		ends.at(-1) as { message?: { content?: Array<{ type: string; text?: string }>; errorMessage?: string } }
	)?.message;
	return message?.errorMessage ?? message?.content?.find((block) => block.type === "text")?.text ?? "";
}

it("runs each session on its own fallback chain from open_session, and leaves the user's settings file untouched", async () => {
	// given
	const faux = fauxWherePrimaryIsAtItsUsageLimit();
	await using host = await contextHost({ faux, globalSettings: USER_SETTINGS });
	const settingsPath = join(host.agentDir, "settings.json");
	const settingsBefore = await readFile(settingsPath);
	const toA = await host.open("conn-a", {
		retryFallback: { modelFallback: true, fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare-a"] } },
	});
	const toB = await host.open("conn-b", {
		retryFallback: { modelFallback: true, fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare-b"] } },
	});

	// when
	await host.prompt("conn-a", String(toA.sessionId), "go");
	await host.prompt("conn-b", String(toB.sessionId), "go");

	// then
	expect(lastAssistantText(host, String(toA.sessionId))).toBe("answered by spare-a");
	expect(lastAssistantText(host, String(toB.sessionId))).toBe("answered by spare-b");
	expect(await readFile(settingsPath)).toEqual(settingsBefore);
}, 120_000);

it("keeps a session opened without a profile on the host's settings: its usage limit has no chain and fails cleanly", async () => {
	// given
	const faux = fauxWherePrimaryIsAtItsUsageLimit();
	await using host = await contextHost({ faux, globalSettings: USER_SETTINGS });
	await host.open("conn-a", {
		retryFallback: { modelFallback: true, fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare-a"] } },
	});
	const plain = await host.open("conn-b", {});

	// when
	await host.prompt("conn-b", String(plain.sessionId), "go");

	// then
	expect(lastAssistantText(host, String(plain.sessionId))).toContain("session limit");
	expect(faux.getCallLog().map((call) => call.modelId)).not.toContain("spare-a");
}, 120_000);

it("refuses a malformed retryFallback instead of opening a session without the chain its caller asked for", async () => {
	await using host = await contextHost();

	const missingFlag = await host.openFailure("conn-a", { retryFallback: { fallbackChains: { a: ["b"] } } });
	const notStrings = await host.openFailure("conn-a", {
		retryFallback: { modelFallback: true, fallbackChains: { a: [1] } },
	});

	expect(missingFlag).toContain("retryFallback");
	expect(notStrings).toContain("retryFallback");
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);

it("advertises retry_fallback_profile, the capability a client waits for before sending the field", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(z.array(z.string()).parse(info.capabilities)).toContain("retry_fallback_profile");
}, 120_000);
