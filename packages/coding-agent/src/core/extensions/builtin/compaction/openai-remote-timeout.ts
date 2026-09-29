import type { OpenAiRemoteCompactionModel } from "./openai-remote-model.ts";

const OPENAI_REMOTE_COMPACTION_TIMEOUT_MS = 15_000;
/**
 * A live subscription-lane v2 compaction took 17.7 s at 16.7k context tokens (senpi#2378). 90 s is about
 * 5x that, headroom for larger contexts; a timeout still falls back to the local summary.
 */
export const CHATGPT_SUBSCRIPTION_REMOTE_COMPACTION_TIMEOUT_MS = 90_000;

export function openAiRemoteCompactionTimeoutMs(model: OpenAiRemoteCompactionModel): number {
	return model.api === "openai-codex-responses"
		? CHATGPT_SUBSCRIPTION_REMOTE_COMPACTION_TIMEOUT_MS
		: OPENAI_REMOTE_COMPACTION_TIMEOUT_MS;
}

export async function runWithRemoteTimeout<T>(options: {
	signal: AbortSignal;
	timeoutMs: number;
	run: (signal: AbortSignal) => Promise<T>;
	onTimeout: () => void;
}): Promise<T | undefined> {
	if (options.signal.aborted) throw new Error("Request was aborted");

	const controller = new AbortController();
	let timedOut = false;
	const abortFromSource = () => controller.abort();
	options.signal.addEventListener("abort", abortFromSource, { once: true });

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			resolve("timeout");
		}, options.timeoutMs);
		timeout.unref?.();
	});

	const operation = options.run(controller.signal);
	try {
		const result = await Promise.race([operation, timeoutPromise]);
		if (result === "timeout") {
			options.onTimeout();
			operation.catch(() => undefined);
			return undefined;
		}
		return result;
	} catch (error) {
		if (timedOut && !options.signal.aborted) {
			options.onTimeout();
			return undefined;
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal.removeEventListener("abort", abortFromSource);
	}
}
