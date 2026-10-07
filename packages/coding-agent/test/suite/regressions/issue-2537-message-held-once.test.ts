import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#2537: a long session's heap grew with every turn because each message was held twice, once in
 * the agent's context and once as a JSON copy in the session mirror. A message the session persisted is
 * now held once: the mirror's message is a shallow copy sharing the agent's content, and both still
 * read exactly what the session file holds.
 */
describe("issue #2537: a persisted message is held once", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function mirrorMessages(harness: Harness): unknown[] {
		return harness.sessionManager
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message);
	}

	it("shares each message's content between the agent context and the session mirror", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("a short reply")]);

		await harness.session.prompt("hello there");

		const live = harness.session.messages.filter(
			(message) => message.role === "user" || message.role === "assistant",
		);
		const mirrored = mirrorMessages(harness) as { content: unknown }[];
		expect(live).toHaveLength(2);
		// The message's content, its bulk, is one array shared by the agent and the mirror.
		for (const message of live) {
			expect(mirrored.some((entry) => entry.content === (message as { content: unknown }).content)).toBe(true);
		}
	});

	it("keeps the mirror equal to a cold reload of the session file", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const file = harness.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("the harness session is not persisted to a file");
		const reloaded = SessionManager.open(file);
		expect(JSON.parse(JSON.stringify(mirrorMessages(harness)))).toEqual(
			reloaded
				.getEntries()
				.filter((entry): entry is SessionMessageEntry => entry.type === "message")
				.map((entry) => entry.message),
		);
	});

	it("puts a failed turn's post-save note on a copy, never on the persisted message object", async () => {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "invalid_image: does not represent a valid image",
			}),
		]);
		const persisted: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") persisted.push(event.message);
		});

		await harness.session.prompt("look", { images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }] });

		const live = harness.session.messages.at(-1);
		expect(live?.role === "assistant" && live.errorMessage).toContain("is left out of later requests");
		// The object handed to persistence (and shared with the session mirror) keeps what the file holds.
		expect(persisted).toHaveLength(1);
		expect((persisted[0] as { errorMessage?: string }).errorMessage).toBe(
			"invalid_image: does not represent a valid image",
		);
		const file = harness.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("the harness session is not persisted to a file");
		const reloaded = SessionManager.open(file)
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message);
		expect(JSON.parse(JSON.stringify(mirrorMessages(harness)))).toEqual(reloaded);
	});
});
