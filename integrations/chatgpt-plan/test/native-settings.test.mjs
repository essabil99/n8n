import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, PLAN_SCOPE } from '../src/auth.mjs';
import { createServers } from '../src/server.mjs';

const key = 'native-settings-test-key-over-24-characters';
const token = 'native-settings-access-token';
const applications = [];
const directories = [];
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-native-settings-'));
	directories.push(directory);
	const store = new TokenStore(directory);
	await store.init();
	await store.save({
		subject: 'fixture',
		email: 'fixture@example.invalid',
		client_id: 'oaiapp_fixture',
		scopes: [PLAN_SCOPE],
		access_token: token,
		refresh_token: 'fixture-refresh',
		expires_at: Date.now() + 3600000,
		model: 'gpt-a',
	});
	const apps = await createServers({
		store,
		apiKey: key,
		fetchImpl: async (url) => {
			expect(url).toBe('https://api.openai.com/v1/models');
			return Response.json({
				models: [
					{ slug: 'gpt-a', visibility: 'list', display_name: 'Model A' },
					{ slug: 'gpt-b', visibility: 'list', display_name: 'Model B' },
					{ slug: 'hidden', visibility: 'hidden' },
				],
			});
		},
	});
	applications.push(apps.infer, apps.admin);
	return { ...apps, store, headers: { authorization: 'Bearer ' + key } };
}
afterEach(async () => {
	for (const app of applications.splice(0)) await app.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
it('requires the bridge key on each native connection route', async () => {
	const { infer } = await setup();
	for (const [method, action] of [
		['GET', 'status'],
		['POST', 'start'],
		['GET', 'models'],
		['POST', 'model'],
	]) {
		const result = await infer.inject({
			method,
			url: '/v1/connection/' + action,
			...(method === 'POST' ? { payload: {} } : {}),
		});
		expect(result.statusCode).toBe(401);
	}
});
it('returns only safe native connection metadata and a validated plan model selection', async () => {
	const { infer, store, headers } = await setup();
	const status = await infer.inject({ url: '/v1/connection/status', headers });
	expect(status.headers['cache-control']).toBe('no-store');
	expect(status.json()).toEqual({
		authenticated: true,
		plan_authorized: true,
		reauthorization_required: false,
		model: 'gpt-a',
		sign_in_pending: false,
	});
	expect(status.body).not.toContain(token);
	expect(status.body).not.toContain('fixture@example.invalid');
	const models = await infer.inject({ url: '/v1/connection/models', headers });
	expect(models.json().models.map(({ slug }) => slug)).toEqual(['gpt-a', 'gpt-b']);
	for (const payload of [
		{ model: 'hidden' },
		{ model: 'gpt-a', url: 'https://example.invalid' },
		{ model: 123 },
	]) {
		const result = await infer.inject({
			method: 'POST',
			url: '/v1/connection/model',
			headers,
			payload,
		});
		expect(result.statusCode).toBe(400);
		expect(store.credentials.model).toBe('gpt-a');
	}
	const result = await infer.inject({
		method: 'POST',
		url: '/v1/connection/model',
		headers,
		payload: { model: 'gpt-b' },
	});
	expect(result.statusCode).toBe(200);
	expect(store.credentials.model).toBe('gpt-b');
});
it('tracks a native sign-in until its callback finishes, without changing the callback address', async () => {
	const { infer, admin, headers } = await setup();
	const result = await infer.inject({
		method: 'POST',
		url: '/v1/connection/start',
		headers,
		payload: {},
	});
	const url = new URL(result.json().url);
	expect(url.origin).toBe('https://auth.openai.com');
	expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(
		(await infer.inject({ url: '/v1/connection/status', headers })).json().sign_in_pending,
	).toBe(true);
	await admin.inject({
		url: '/auth/callback?state=' + url.searchParams.get('state') + '&error=access_denied',
		headers: { host: '127.0.0.1:1455' },
	});
	expect(
		(await infer.inject({ url: '/v1/connection/status', headers })).json().sign_in_pending,
	).toBe(false);
});
