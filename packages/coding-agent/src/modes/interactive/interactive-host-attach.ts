/**
 * Ensures the shared host and attaches the client to it, holding the ensured host until the
 * client's own connection is up so a short idle window cannot close in between (senpi#2227).
 */
export async function attachEnsuredHost(
	ensure: () => Promise<{ release(): void } | undefined>,
	client: { start(): Promise<void> },
): Promise<void> {
	const ensured = await ensure();
	try {
		await client.start();
	} finally {
		ensured?.release();
	}
}
