import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TokenStore, ISSUER, RESOURCE, PLAN_SCOPE, verifyIdentity } from '../src/auth.mjs';
import { normalizeRequest, collectResponse } from '../src/protocol.mjs';
import { createServers } from '../src/server.mjs';

const directories = [];
const servers = [];
const KEY = 'test-bridge-key-with-more-than-24-characters';
const validCredentials = {
	subject: 'test-account',
	email: 'test@example.invalid',
	client_id: 'oaiapp_test',
	access_token: 'test-access',
	refresh_token: 'test-refresh',
	id_token: 'test-id-token',
	scopes: [PLAN_SCOPE],
	expires_at: Date.now() + 3_600_000,
};
const complete = {
	id: 'resp_test',
	object: 'response',
	status: 'completed',
	model: 'gpt-6.1-sol',
	output: [
		{
			type: 'message',
			role: 'assistant',
			id: 'msg_test',
			status: 'completed',
			content: [{ type: 'output_text', text: 'OK', annotations: [] }],
		},
	],
	usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const responseStream = (value) =>
	new Response(event({ type: 'response.completed', response: value }), {
		headers: { 'Content-Type': 'text/event-stream' },
	});

async function newStore(options = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-chatgpt-plan-test-'));
	directories.push(directory);
	const store = new TokenStore(directory, options);
	await store.init();
	return store;
}
async function newServers(options = {}) {
	const store = await newStore();
	await store.save(validCredentials);
	const apps = await createServers({ store, apiKey: KEY, ...options });
	servers.push(apps.infer, apps.admin);
	return { ...apps, store };
}
afterEach(async () => {
	for (const app of servers.splice(0)) await app.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe('Responses compatibility', () => {
	it('keeps full history and tools while applying ChatGPT plan fields', () => {
		const result = normalizeRequest(
			{
				model: 'chatgpt-plan',
				input: [
					{ type: 'message', role: 'system', content: 'Build workflows.' },
					{ type: 'function_call', call_id: 'call_1', name: 'list_workflows', arguments: '{}' },
					{ type: 'function_call_output', call_id: 'call_1', output: '[]' },
				],
				tools: [{ type: 'function', name: 'list_workflows', parameters: { type: 'object' } }],
				max_output_tokens: 16,
				temperature: 0.2,
				metadata: { trace: 'test' },
				store: true,
				stream: false,
			},
			'gpt-6.1-sol',
		);
		expect(result).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true });
		expect(result).not.toHaveProperty('max_output_tokens');
		expect(result).not.toHaveProperty('temperature');
		expect(result).not.toHaveProperty('metadata');
		expect(result.input[0].role).toBe('developer');
		expect(result.input[1].namespace).toBe('n8n');
		expect(result.input[2].output).toBe('[]');
		expect(result.tools[0]).toMatchObject({
			type: 'namespace',
			name: 'n8n',
			tools: [{ name: 'list_workflows' }],
		});
		expect(result.include).toContain('reasoning.encrypted_content');
	});
	it('rejects stored history and unsupported hosted tools', () => {
		expect(() =>
			normalizeRequest({ model: 'test', input: [], previous_response_id: 'old' }),
		).toThrow('full conversation');
		expect(() =>
			normalizeRequest({ model: 'test', input: [], tools: [{ type: 'tool_search' }] }),
		).toThrow('not supported');
	});
	it('collects completed SSE for the n8n setup probe', async () => {
		expect(await collectResponse(responseStream(complete).body)).toEqual(complete);
	});
	it('rejects failed and abruptly ended inference', async () => {
		await expect(
			collectResponse(
				new Response(event({ type: 'response.failed', response: { status: 'failed' } })).body,
			),
		).rejects.toThrow('did not complete');
		await expect(
			collectResponse(
				new Response(event({ type: 'response.output_text.delta', delta: 'partial' })).body,
			),
		).rejects.toThrow('did not complete');
	});
});

describe('ChatGPT connection', () => {
	it('distinguishes a rejected initial code exchange from token renewal without exposing provider text', async () => {
		const store = await newStore({
			fetch: async () =>
				Response.json(
					{ error: 'invalid_grant', error_description: 'private diagnostic' },
					{ status: 400 },
				),
		});
		const url = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		await expect(
			store.exchange({
				state: url.searchParams.get('state'),
				code: 'test-code',
				client_id: 'oaiapp_test',
			}),
		).rejects.toMatchObject({
			code: 'sign_in_exchange_failed',
			message: expect.stringContaining('HTTP 400, invalid_grant'),
		});
		expect(store.lastAuthError).toEqual({
			phase: 'code_exchange',
			http_status: 400,
			provider_code: 'invalid_grant',
			request_id: null,
		});
		expect(store.status().authenticated).toBe(false);
		const retry = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		expect(retry.searchParams.get('client_id')).toBe('oaiapp_test');
		expect(retry.searchParams.has('agent_name_hint')).toBe(false);
		expect(retry.searchParams.get('state')).not.toBe(url.searchParams.get('state'));
		expect(retry.searchParams.get('code_challenge')).not.toBe(
			url.searchParams.get('code_challenge'),
		);
	});

	it('uses fresh PKCE values and a persistent host ID', async () => {
		const store = await newStore();
		const first = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		const second = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client');
		expect(first.searchParams.get('scope')).toContain(PLAN_SCOPE);
		expect(first.searchParams.get('resource')).toBe(RESOURCE);
		expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'));
		expect(first.searchParams.get('code_challenge')).not.toBe(
			second.searchParams.get('code_challenge'),
		);
		const restarted = new TokenStore(store.directory);
		await restarted.init();
		expect(restarted.hostId).toBe(store.hostId);
	});
	it('exchanges the issued client ID and stores credentials with owner permissions', async () => {
		const tokenFetch = vi.fn(async () =>
			Response.json({
				access_token: 'issued-access',
				refresh_token: 'issued-refresh',
				id_token: 'issued-id',
				expires_in: 3600,
				scope: `openid ${PLAN_SCOPE}`,
			}),
		);
		const verify = vi.fn(async () => ({ sub: 'account', email: 'account@example.invalid' }));
		const store = await newStore({ fetch: tokenFetch, verify });
		const url = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		await store.exchange({
			state: url.searchParams.get('state'),
			code: 'test-code',
			client_id: 'oaiapp_issued',
		});
		const grant = tokenFetch.mock.calls[0][1].body;
		expect(grant.get('client_id')).toBe('oaiapp_issued');
		expect(createHash('sha256').update(grant.get('code_verifier')).digest('base64url')).toBe(
			url.searchParams.get('code_challenge'),
		);
		expect(grant.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
		expect(verify).toHaveBeenCalledWith(
			'issued-id',
			'oaiapp_issued',
			url.searchParams.get('nonce'),
		);
		expect((await stat(join(store.directory, 'credentials.json'))).mode & 0o777).toBe(0o600);
		expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
		expect(store.status()).not.toHaveProperty('access_token');
		await expect(
			store.exchange({
				state: url.searchParams.get('state'),
				code: 'test-code',
				client_id: 'oaiapp_issued',
			}),
		).rejects.toThrow('state');
	});
	it('rejects incorrect state and retains a verified sign-in without plan permission', async () => {
		const tokenFetch = vi.fn(async () =>
			Response.json({
				access_token: 'new',
				refresh_token: 'new-refresh',
				id_token: 'new-id',
				expires_in: 3600,
				scope: 'openid',
			}),
		);
		const store = await newStore({
			fetch: tokenFetch,
			verify: async () => ({ sub: 'test-account' }),
		});
		await store.save(validCredentials);
		await expect(store.exchange({ state: 'wrong', code: 'code' })).rejects.toThrow('state');
		expect(tokenFetch).not.toHaveBeenCalled();
		const url = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		expect(url.searchParams.get('client_id')).toBe('oaiapp_test');
		expect(url.searchParams.has('agent_name_hint')).toBe(false);
		await store.exchange({ state: url.searchParams.get('state'), code: 'code' });
		expect(store.status()).toMatchObject({ authenticated: true, plan_authorized: false });
		await expect(store.accessToken()).rejects.toThrow('not authorized');
		const reconsent = new URL(store.start('http://127.0.0.1:1455/auth/callback'));
		expect(reconsent.searchParams.get('prompt')).toBe('consent');
	});
	it('validates the real JWT signature, issuer, audience, and nonce', async () => {
		const { publicKey, privateKey } = await generateKeyPair('RS256');
		const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
		const jwt = await new SignJWT({ nonce: 'expected' })
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer(ISSUER)
			.setAudience('oaiapp_test')
			.setSubject('test-account')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);
		expect((await verifyIdentity(jwt, 'oaiapp_test', 'expected', keys)).sub).toBe('test-account');
		await expect(verifyIdentity(jwt, 'wrong-client', 'expected', keys)).rejects.toThrow();
		await expect(verifyIdentity(jwt, 'oaiapp_test', 'wrong-nonce', keys)).rejects.toThrow(
			'validation',
		);
	});
	it('serializes refreshes and saves the rotating token before returning', async () => {
		const tokenFetch = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
		});
		const store = await newStore({ fetch: tokenFetch });
		await store.save({ ...validCredentials, expires_at: Date.now() - 1000 });
		expect(
			await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]),
		).toEqual(['renewed', 'renewed', 'renewed']);
		expect(tokenFetch).toHaveBeenCalledTimes(1);
		expect(tokenFetch.mock.calls[0][1].body.get('client_id')).toBe('oaiapp_test');
		expect(tokenFetch.mock.calls[0][1].body.has('scope')).toBe(false);
		const saved = JSON.parse(await readFile(join(store.directory, 'credentials.json'), 'utf8'));
		expect(saved.refresh_token).toBe('rotated');
		expect(saved.access_token).toBe('renewed');
	});
	it('does not refresh earlier than the server allows', async () => {
		const tokenFetch = vi.fn();
		const store = await newStore({ fetch: tokenFetch });
		await store.save({
			...validCredentials,
			expires_at: Date.now() + 30_000,
			earliest_refresh_at: Date.now() + 15_000,
		});
		expect(await store.accessToken()).toBe('test-access');
		expect(tokenFetch).not.toHaveBeenCalled();
	});
});

describe('bridge routes', () => {
	it('accepts a one-message SDK input array without coercing it', async () => {
		const upstream = vi.fn(async () => responseStream(complete));
		const { infer } = await newServers({ fetchImpl: upstream });
		const input = [{ role: 'user', content: [{ type: 'input_text', text: 'PROBE' }] }];
		const reply = await infer.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: `Bearer ${KEY}` },
			payload: { model: 'chatgpt-plan', input },
		});
		expect(reply.statusCode).toBe(200);
		expect(JSON.parse(upstream.mock.calls[0][1].body).input).toEqual(input);
	});

	it('accepts localhost for the admin page but keeps the exact loopback callback', async () => {
		const { admin } = await newServers();
		const page = await admin.inject({ url: '/', headers: { host: 'localhost:1455' } });
		expect(page.statusCode).toBe(200);
		const start = await admin.inject({
			method: 'POST',
			url: '/auth/start',
			headers: {
				host: 'localhost:1455',
				origin: 'http://localhost:1455',
			},
		});
		expect(start.statusCode).toBe(200);
		expect(new URL(start.json().url).searchParams.get('redirect_uri')).toBe(
			'http://127.0.0.1:1455/auth/callback',
		);
	});

	it('requires the bridge key before it makes an inference request', async () => {
		const upstream = vi.fn();
		const { infer } = await newServers({ fetchImpl: upstream });
		const response = await infer.inject({
			method: 'POST',
			url: '/v1/responses',
			payload: { model: 'chatgpt-plan', input: 'hello' },
		});
		expect(response.statusCode).toBe(401);
		expect(upstream).not.toHaveBeenCalled();
	});
	it('adapts the non-streaming setup probe and only forwards the OAuth token', async () => {
		const upstream = vi.fn(async () => responseStream(complete));
		const { infer } = await newServers({ fetchImpl: upstream });
		const response = await infer.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: `Bearer ${KEY}` },
			payload: {
				model: 'chatgpt-plan',
				input: 'Reply with OK.',
				stream: false,
				max_output_tokens: 16,
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(complete);
		expect(upstream.mock.calls[0][0]).toBe(`${RESOURCE}/responses`);
		expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer test-access');
		const sent = JSON.parse(upstream.mock.calls[0][1].body);
		expect(sent.stream).toBe(true);
		expect(sent.store).toBe(false);
		expect(sent).not.toHaveProperty('max_output_tokens');
	});
	it('preserves streamed tool calls for n8n', async () => {
		const toolResponse = {
			...complete,
			output: [
				{
					type: 'function_call',
					id: 'fc_test',
					call_id: 'call_1',
					namespace: 'n8n',
					name: 'list_workflows',
					arguments: '{}',
				},
			],
		};
		const { infer } = await newServers({ fetchImpl: async () => responseStream(toolResponse) });
		const response = await infer.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: `Bearer ${KEY}` },
			payload: {
				model: 'chatgpt-plan',
				input: 'List workflows.',
				stream: true,
				tools: [{ type: 'function', name: 'list_workflows', parameters: { type: 'object' } }],
			},
		});
		expect(response.headers['content-type']).toContain('text/event-stream');
		expect(response.body).toContain('list_workflows');
		expect(response.body).toContain('"call_id":"call_1"');
	});
	it('returns usage limits without a paid fallback or a retry', async () => {
		const upstream = vi.fn(async () =>
			Response.json(
				{
					error: {
						code: 'subscription_sharing_usage_limit_exceeded',
						message: 'ChatGPT plan usage limit reached.',
					},
				},
				{ status: 429, headers: { 'Retry-After': '300' } },
			),
		);
		const { infer } = await newServers({ fetchImpl: upstream });
		const response = await infer.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: `Bearer ${KEY}` },
			payload: { model: 'chatgpt-plan', input: 'hello' },
		});
		expect(response.statusCode).toBe(429);
		expect(response.headers['retry-after']).toBe('300');
		expect(response.body).toContain('plan usage limit');
		expect(response.body).not.toContain('private error');
		expect(upstream).toHaveBeenCalledTimes(1);
	});
	it('rejects an admin request from another host or origin', async () => {
		const { admin } = await newServers();
		expect(
			(await admin.inject({ url: '/', headers: { host: 'untrusted.invalid' } })).statusCode,
		).toBe(403);
		expect(
			(
				await admin.inject({
					method: 'POST',
					url: '/auth/start',
					headers: { host: '127.0.0.1:1455', origin: 'https://untrusted.invalid' },
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await admin.inject({
					method: 'POST',
					url: '/auth/start',
					headers: { host: '127.0.0.1:1455', origin: 'http://127.0.0.1:1455' },
				})
			).statusCode,
		).toBe(200);
	});
});
