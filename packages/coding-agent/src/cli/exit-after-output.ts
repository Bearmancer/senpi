type DrainableStream = Pick<NodeJS.WriteStream, "writableLength" | "destroyed" | "once" | "off">;

function drained(stream: DrainableStream): Promise<void> {
	if (stream.destroyed || stream.writableLength === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const done = (): void => {
			stream.off("drain", done);
			stream.off("error", done);
			stream.off("close", done);
			resolve();
		};
		stream.once("drain", done);
		stream.once("error", done);
		stream.once("close", done);
	});
}

/**
 * Exits once everything already written to stdout and stderr has left the process. Under Node, a
 * write to a pipe is asynchronous, and `process.exit()` drops whatever a slow reader has not taken
 * yet while still reporting success (senpi#2937). A reader that closes the pipe ends the wait.
 */
export async function exitAfterOutput(code?: number): Promise<never> {
	await Promise.all([drained(process.stdout), drained(process.stderr)]);
	process.exit(code);
}
