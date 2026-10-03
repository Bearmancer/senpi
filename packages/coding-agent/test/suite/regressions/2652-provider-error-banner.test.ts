import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	isNetworkProviderError,
	isRetryableProviderError,
	ProviderErrorPresentation,
} from "../../../src/modes/interactive/provider-error-presentation.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/2652
describe("provider error presentation classification", () => {
	test("a 429 rate-limit takes the quiet retry path, not the raw-JSON verbose path", () => {
		const rateLimited =
			'Error: 429: {"message":"rate limit exceeded","type":"rate_limit_exceeded"} (retry-after-ms: 20000)';
		expect(isRetryableProviderError(rateLimited)).toBe(true);
	});

	test("a 5xx provider error takes the quiet retry path", () => {
		expect(isRetryableProviderError("Error: 500: internal server error")).toBe(true);
		expect(isRetryableProviderError("Error: 503: service unavailable")).toBe(true);
	});

	test("a network drop takes the quiet retry path", () => {
		expect(isRetryableProviderError("fetch failed")).toBe(true);
		expect(isNetworkProviderError("fetch failed")).toBe(true);
	});

	test("hard auth/quota failures stay verbose (they need a credential, not a wait)", () => {
		expect(isRetryableProviderError("401 Incorrect API key provided")).toBe(false);
		expect(isRetryableProviderError("insufficient_quota: you exceeded your current quota")).toBe(false);
		expect(isRetryableProviderError("credit balance too low")).toBe(false);
	});

	test("empty/undefined input is never quiet", () => {
		expect(isRetryableProviderError(undefined)).toBe(false);
		expect(isRetryableProviderError("")).toBe(false);
	});
});

// A terminal compaction failure after an episode that already finished must not reopen the stale
// banner: the quiet finish() is gated on a retry recorded in the CURRENT episode.
describe("provider error episode marker", () => {
	const envelope = JSON.stringify({
		type: "error",
		error: { type: "api_error", message: "Network error or service unavailable" },
	});

	test("a recorded retry marks the episode as awaiting finish until finish() closes it", () => {
		const p = new ProviderErrorPresentation(new Container());
		expect(p.awaitingRetryFinish).toBe(false);
		p.retrying(envelope, false);
		expect(p.awaitingRetryFinish).toBe(true);
		p.finish(envelope);
		expect(p.awaitingRetryFinish).toBe(false);
	});

	test("after a finished episode, a fresh failure is NOT awaiting finish (surfaces as an error)", () => {
		const p = new ProviderErrorPresentation(new Container());
		p.retrying(envelope, false);
		p.finish(envelope);
		// A later, never-retried terminal failure on the same banner: no current retry episode.
		expect(p.awaitingRetryFinish).toBe(false);
	});

	test("a retry recorded then cleared still awaits finish (the exhausted close-out)", () => {
		const p = new ProviderErrorPresentation(new Container());
		p.retrying(envelope, false);
		p.clear();
		expect(p.awaitingRetryFinish).toBe(true);
	});
});
