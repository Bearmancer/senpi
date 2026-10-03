import { describe, expect, test } from "vitest";
import {
	isNetworkProviderError,
	isRetryableProviderError,
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
