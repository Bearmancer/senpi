import { nextRenderRevision } from "@earendil-works/pi-tui";
import {
	registerTuiRenderCacheSource,
	type TuiRenderCacheTotals,
} from "../../../core/memory-report/memory-report-registry.ts";

// Process-wide totals over every live tool card, kept by O(1) updates; the memory report reads them.
const totals = { components: 0, cachedLines: 0, images: 0 };
let totalsReported = false;

function readTotals(): TuiRenderCacheTotals {
	return { ...totals };
}

/** One tool card's rendered-lines cache and render revision, counted in the process-wide totals. */
export class ToolExecutionRenderCache {
	#lines: string[] | undefined;
	#signature: string | undefined;
	#width: number | undefined;
	#images = 0;
	#disposed = false;
	#revision = nextRenderRevision();

	constructor() {
		totals.components++;
		if (totalsReported) return;
		totalsReported = true;
		registerTuiRenderCacheSource(readTotals);
	}

	/** Changes with every invalidation, so a finished card can skip rendering an unchanged frame. */
	get revision(): number {
		return this.#revision;
	}

	read(width: number, signature: string): string[] | undefined {
		if (!this.#lines || this.#width !== width || this.#signature !== signature) return undefined;
		return [...this.#lines];
	}

	store(width: number, signature: string, lines: readonly string[]): void {
		this.#dropLines();
		this.#width = width;
		this.#signature = signature;
		this.#lines = [...lines];
		totals.cachedLines += lines.length;
	}

	invalidate(): void {
		this.#dropLines();
		this.#revision = nextRenderRevision();
	}

	/** Image parts the card's current result holds. */
	setImages(count: number): void {
		totals.images += count - this.#images;
		this.#images = count;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#dropLines();
		this.setImages(0);
		totals.components--;
	}

	#dropLines(): void {
		totals.cachedLines -= this.#lines?.length ?? 0;
		this.#lines = undefined;
		this.#signature = undefined;
		this.#width = undefined;
	}
}
