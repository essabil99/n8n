import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError, TOKEN_ENDPOINT } from './auth.mjs';

// The desktop controller redeems the code locally, then transfers the protected result over SSH.
// The VM keeps ownership of state, identity validation, credentials, and subsequent refreshes.
export function localCodeExchange(store, { pollMs = 200 } = {}) {
	return async (endpoint, options) => {
		if (endpoint !== TOKEN_ENDPOINT) throw new Error('Unexpected OAuth token endpoint.');
		const id = randomUUID();
		const requestName = `exchange-${id}.request.json`;
		const claimedName = `exchange-${id}.claimed.json`;
		const responseName = `exchange-${id}.response.json`;
		await store.atomicWrite(
			requestName,
			JSON.stringify({
				version: 1,
				id,
				endpoint,
				body: options.body.toString(),
				created_at: Date.now(),
				expires_at: Date.now() + 30_000,
			}),
		);
		try {
			while (!options.signal.aborted) {
				try {
					const result = JSON.parse(await readFile(join(store.directory, responseName), 'utf8'));
					if (
						result.version !== 1 ||
						result.id !== id ||
						!Number.isInteger(result.status) ||
						result.status < 200 ||
						result.status > 599 ||
						typeof result.body !== 'string'
					) {
						throw new BridgeError(
							502,
							'local_exchange_invalid',
							'The local OAuth result is invalid.',
						);
					}
					if (result.transport_error) {
						throw new BridgeError(
							503,
							'local_exchange_unreachable',
							'The browser computer could not reach ChatGPT sign-in. Start a fresh sign-in after its connection recovers.',
						);
					}
					return new Response(result.body, {
						status: result.status,
						headers: {
							'Content-Type': 'application/json',
							...(result.request_id ? { 'X-Request-Id': result.request_id } : {}),
						},
					});
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, pollMs));
			}
			throw new BridgeError(
				503,
				'local_exchange_timeout',
				'The local OAuth controller did not return a result. Check that it is running before starting a fresh sign-in.',
			);
		} finally {
			await Promise.all(
				[requestName, claimedName, responseName].map((name) =>
					rm(join(store.directory, name), { force: true }),
				),
			);
		}
	};
}
