import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, TOKEN_ENDPOINT, PLAN_SCOPE } from '../src/auth.mjs';
import { localCodeExchange } from '../src/local-exchange.mjs';

const directories = [];
async function store(options = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-local-oauth-'));
	directories.push(directory);
	const result = new TokenStore(directory, options);
	await result.init();
	return result;
}
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

it('transfers the exact PKCE form and protected result without changing the VM host ID', async () => {
	const vm = await store({ verify: async () => ({ sub: 'test-account' }), fetch: vi.fn() });
	vm.codeExchangeFetch = localCodeExchange(vm, { pollMs: 2 });
	const url = new URL(vm.start('http://127.0.0.1:1455/auth/callback'));
	const hostId = vm.hostId;
	const exchange = vm.exchange({
		state: url.searchParams.get('state'),
		code: 'single-use-code',
		client_id: 'oaiapp_local',
	});
	let name;
	for (let index = 0; index < 100; index++) {
		name = (await readdir(vm.directory)).find((file) => file.endsWith('.request.json'));
		if (name) break;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	expect(name).toBeTruthy();
	expect((await stat(join(vm.directory, name))).mode & 0o777).toBe(0o600);
	const request = JSON.parse(await readFile(join(vm.directory, name), 'utf8'));
	const form = new URLSearchParams(request.body);
	expect(request.endpoint).toBe(TOKEN_ENDPOINT);
	expect(form.get('client_id')).toBe('oaiapp_local');
	expect(form.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
	expect(createHash('sha256').update(form.get('code_verifier')).digest('base64url')).toBe(
		url.searchParams.get('code_challenge'),
	);
	await vm.atomicWrite(
		name.replace('.request.json', '.response.json'),
		JSON.stringify({
			version: 1,
			id: request.id,
			status: 200,
			body: JSON.stringify({
				access_token: 'test-access',
				refresh_token: 'test-refresh',
				id_token: 'test-id',
				expires_in: 3600,
				scope: PLAN_SCOPE,
			}),
		}),
	);
	await exchange;
	expect(vm.fetch).not.toHaveBeenCalled();
	expect(vm.hostId).toBe(hostId);
	expect(vm.credentials.ext_agent_host_id).toBe(hostId);
	expect((await readdir(vm.directory)).some((file) => file.startsWith('exchange-'))).toBe(false);
	const restarted = new TokenStore(vm.directory);
	await restarted.init();
	expect(restarted.retryClientId).toBe('oaiapp_local');
});

it('redeems an authorization code only once after a server or network failure', async () => {
	for (const network of [false, true]) {
		const tokenFetch = vi.fn(async () => {
			if (network) throw new Error('offline');
			return Response.json({ error: 'server_error' }, { status: 503 });
		});
		const vm = await store({ fetch: tokenFetch });
		const url = new URL(vm.start('http://127.0.0.1:1455/auth/callback'));
		await expect(
			vm.exchange({ state: url.searchParams.get('state'), code: 'once', client_id: 'oaiapp_once' }),
		).rejects.toThrow();
		expect(tokenFetch).toHaveBeenCalledTimes(1);
		const restarted = new TokenStore(vm.directory);
		await restarted.init();
		expect(
			new URL(restarted.start('http://127.0.0.1:1455/auth/callback')).searchParams.get('client_id'),
		).toBe('oaiapp_once');
	}
});

it('retains a valid identity without plan scope and never attempts inference with it', async () => {
	const tokenFetch = vi.fn(async () =>
		Response.json({
			access_token: 'identity-access',
			id_token: 'identity-id',
			expires_in: 3600,
			scope: 'openid profile email',
		}),
	);
	const vm = await store({ fetch: tokenFetch, verify: async () => ({ sub: 'test-account' }) });
	const url = new URL(vm.start('http://127.0.0.1:1455/auth/callback'));
	expect(url.searchParams.get('scope')).toContain(PLAN_SCOPE);
	expect(url.searchParams.get('resource')).toBe('https://api.openai.com/v1');
	await vm.exchange({
		state: url.searchParams.get('state'),
		code: 'identity-code',
		client_id: 'oaiapp_identity',
	});
	expect(vm.status()).toMatchObject({ authenticated: true, plan_authorized: false });
	expect(tokenFetch.mock.calls[0][1].body.get('resource')).toBe('https://api.openai.com/v1');
	await expect(vm.accessToken()).rejects.toMatchObject({
		status: 403,
		code: 'plan_not_authorized',
	});
	expect(tokenFetch).toHaveBeenCalledTimes(1);
});

it('cleans up an abandoned local transfer without saving tokens', async () => {
	const vm = await store();
	const transfer = localCodeExchange(vm, { pollMs: 1 });
	await expect(
		transfer(TOKEN_ENDPOINT, {
			body: new URLSearchParams({ code: 'expired' }),
			signal: AbortSignal.timeout(8),
		}),
	).rejects.toMatchObject({ code: 'local_exchange_timeout' });
	expect((await readdir(vm.directory)).some((file) => file.startsWith('exchange-'))).toBe(false);
	expect(vm.credentials).toBeNull();
});
