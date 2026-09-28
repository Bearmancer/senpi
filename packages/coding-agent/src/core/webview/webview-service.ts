import { randomUUID } from "node:crypto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { retireBunChrome, settleDeadBunChrome } from "./bun-chrome.ts";
import { mainThreadWebViewClass, type NativeWebView, type NativeWebViewClass } from "./native-webview.ts";
import { WebViewServiceClient } from "./webview-client.ts";

export interface WebViewClientGrant {
	readonly clientId: string;
	readonly port: MessagePort;
}

/**
 * Serves Chrome-backed `Bun.WebView`s on the process main thread (Bun allows that backend nowhere
 * else) for eval kernels running in worker threads. Every kernel gets its own client: a private
 * MessagePort plus the views created through it, released as a unit by the owner that asked.
 */
export class WebViewService {
	readonly #webViewClass: NativeWebViewClass;
	readonly #clients = new Map<string, WebViewServiceClient>();
	#retiring: Promise<void> = Promise.resolve();
	#chromeInUse = false;

	constructor(webViewClass: NativeWebViewClass) {
		this.#webViewClass = webViewClass;
	}

	get viewCount(): number {
		let count = 0;
		for (const client of this.#clients.values()) count += client.viewCount;
		return count;
	}

	connect(owner: object): WebViewClientGrant {
		const clientId = randomUUID();
		const channel = new MessageChannel();
		const client = new WebViewServiceClient(clientId, owner, channel.port1, {
			createView: (options, onConsole) => this.#createView(options, onConsole),
			onClientClosed: (closed) => void this.#drop(closed),
		});
		this.#clients.set(clientId, client);
		return { clientId, port: channel.port2 };
	}

	/**
	 * Only the owner that connected a client can release it. Resolves after any Chrome retirement in
	 * flight, including one a closed port (the client's worker died first) already started.
	 */
	async release(clientId: string, owner: object): Promise<void> {
		const client = this.#clients.get(clientId);
		if (client?.owner === owner) await this.#drop(client);
		await this.#retiring;
	}

	async releaseOwner(owner: object): Promise<void> {
		const owned = [...this.#clients.values()].filter((client) => client.owner === owner);
		await Promise.all(owned.map((client) => this.#drop(client)));
		await this.#retiring;
	}

	async #createView(
		options: Readonly<Record<string, unknown>>,
		onConsole: ((...args: unknown[]) => void) | undefined,
	): Promise<NativeWebView> {
		await this.#retiring;
		await settleDeadBunChrome();
		this.#chromeInUse = true;
		const viewOptions = onConsole ? { ...options, console: onConsole } : options;
		for (let attempt = 1; ; attempt++) {
			try {
				return new this.#webViewClass(viewOptions);
			} catch (error) {
				if (!isChromeRelaunchWindow(error) || attempt >= RELAUNCH_ATTEMPTS) throw error;
				await new Promise((resolve) => setTimeout(resolve, RELAUNCH_RETRY_MS));
			}
		}
	}

	async #drop(client: WebViewServiceClient): Promise<void> {
		if (this.#clients.get(client.id) !== client) return await this.#retiring;
		this.#clients.delete(client.id);
		client.release();
		if (!this.#chromeInUse || this.viewCount > 0) return await this.#retiring;
		this.#chromeInUse = false;
		this.#retiring = this.#retiring.then(() =>
			this.viewCount > 0 ? undefined : retireBunChrome(this.#webViewClass),
		);
		await this.#retiring;
	}
}

// Right after Chrome dies, Windows refuses to relaunch it for about a second (Bun reports
// ERR_DLOPEN_FAILED "Failed to spawn Chrome"); a missing Chrome fails the same way, so the
// retry is bounded and the last error is surfaced.
const RELAUNCH_ATTEMPTS = 8;
const RELAUNCH_RETRY_MS = 250;

function isChromeRelaunchWindow(error: unknown): boolean {
	return error instanceof Error && Reflect.get(error, "code") === "ERR_DLOPEN_FAILED";
}

const SERVICE_KEY = Symbol.for("senpi.webview.service");

function isWebViewService(value: unknown): value is WebViewService {
	return value instanceof WebViewService;
}

/** The process-wide service, created on first use; undefined off the main thread or without `Bun.WebView`. */
export function mainThreadWebViewService(): WebViewService | undefined {
	const existing: unknown = Reflect.get(globalThis, SERVICE_KEY);
	if (isWebViewService(existing)) return existing;
	const webViewClass = mainThreadWebViewClass();
	if (!webViewClass) return undefined;
	const service = new WebViewService(webViewClass);
	Reflect.set(globalThis, SERVICE_KEY, service);
	return service;
}
