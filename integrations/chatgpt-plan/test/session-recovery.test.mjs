import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, PLAN_SCOPE } from '../src/auth.mjs';
const paths = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function savedStore(fetch) {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-refresh-recovery-'));
	paths.push(directory);
	const store = new TokenStore(directory, { fetch });
	await store.init();
	await store.save({
		client_id: 'oaiapp_recovery',
		subject: 'test-account',
		id_token: 'test-id-hint',
		access_token: 'old-access',
		refresh_token: 'old-refresh',
		scopes: [PLAN_SCOPE],
		expires_at: 1,
	});
	return store;
}
it('clears unusable refresh tokens but retains registration and account hints across restarts', async () => {
	const fetch = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
	const store = await savedStore(fetch);
	await expect(store.accessToken()).rejects.toMatchObject({ code: 'reauthorization_required' });
	const saved = JSON.parse(await readFile(join(store.directory, 'credentials.json'), 'utf8'));
	expect(saved.access_token).toBeNull();
	expect(saved.refresh_token).toBeNull();
	const restarted = new TokenStore(store.directory, { fetch });
	await restarted.init();
	expect(restarted.status()).toMatchObject({
		authenticated: false,
		plan_authorized: false,
		reauthorization_required: true,
	});
	const login = new URL(restarted.start('http://127.0.0.1:1455/auth/callback'));
	expect(login.searchParams.get('client_id')).toBe('oaiapp_recovery');
	expect(login.searchParams.get('id_token_hint')).toBe('test-id-hint');
	await expect(restarted.accessToken()).rejects.toMatchObject({ code: 'reauthorization_required' });
	expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves tokens and avoids replay after an ambiguous network failure or temporary rejection', async () => {
	for (const network of [true, false]) {
		const fetch = vi.fn(async () => {
			if (network) throw new Error('response lost');
			return Response.json({ error: 'server_error' }, { status: 503 });
		});
		const store = await savedStore(fetch);
		await expect(store.accessToken()).rejects.toThrow();
		expect(store.credentials.refresh_token).toBe('old-refresh');
		expect(store.credentials.reauthorization_required).not.toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	}
});
