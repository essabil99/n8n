import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { TokenStore, PLAN_SCOPE } from '../src/auth.mjs';
import { createServers } from '../src/server.mjs';

const key = 'stream-test-bridge-key-over-24-characters';
const token = 'stream-test-oauth-token';
const applications = [];
const directories = [];
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const payload = { model: 'chatgpt-plan', input: 'test', stream: false };
async function servers(fetchImpl) {
	const directory = await mkdtemp(join(tmpdir(), 'n8n-stream-lifecycle-'));
	directories.push(directory);
	const store = new TokenStore(directory);
	await store.init();
	await store.save({
		client_id: 'oaiapp_fixture',
		subject: 'fixture',
		scopes: [PLAN_SCOPE],
		access_token: token,
		refresh_token: 'fixture-refresh',
		expires_at: Date.now() + 3600000,
	});
	const apps = await createServers({ store, apiKey: key, fetchImpl });
	applications.push(apps.infer, apps.admin);
	return apps;
}
afterEach(async () => {
	for (const app of applications.splice(0)) await app.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

it('preserves a plan limit received after SSE starts during a non-streaming n8n probe', async () => {
	const fetchImpl = vi.fn(
		async () =>
			new Response(
				event({
					type: 'error',
					code: 'subscription_sharing_usage_limit_exceeded',
					message: `Plan limit: ${token} ${key}`,
					param: 'model',
				}),
				{
					headers: {
						'content-type': 'text/event-stream',
						'x-request-id': 'req-stream-limit',
						'retry-after': '120',
					},
				},
			),
	);
	const { infer } = await servers(fetchImpl);
	const response = await infer.inject({
		method: 'POST',
		url: '/v1/responses',
		headers: { authorization: `Bearer ${key}` },
		payload,
	});
	expect(response.statusCode).toBe(429);
	expect(response.json().error).toMatchObject({
		code: 'subscription_sharing_usage_limit_exceeded',
		param: 'model',
	});
	expect(response.headers['x-request-id']).toBe('req-stream-limit');
	expect(response.headers['retry-after']).toBe('120');
	expect(response.body).not.toContain(token);
	expect(response.body).not.toContain(key);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('keeps response.failed details for title and memory requests', async () => {
	const { infer } = await servers(
		async () =>
			new Response(
				event({
					type: 'response.failed',
					response: {
						status: 'failed',
						error: { code: 'model_output_failed', message: 'Model output failed.', param: null },
					},
				}),
				{ headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-stream-failed' } },
			),
	);
	const response = await infer.inject({
		method: 'POST',
		url: '/v1/responses',
		headers: { authorization: `Bearer ${key}` },
		payload,
	});
	expect(response.statusCode).toBe(502);
	expect(response.json().error).toEqual({
		code: 'model_output_failed',
		message: 'Model output failed.',
		param: null,
	});
	expect(response.headers['x-request-id']).toBe('req-stream-failed');
});

it('forwards successful stream request IDs without rewriting tool events', async () => {
	const wire = event({
		type: 'response.output_item.added',
		item: {
			type: 'function_call',
			call_id: 'call_fixture',
			name: 'workflows',
			namespace: 'n8n',
			arguments: '{}',
		},
	});
	const { infer } = await servers(
		async () =>
			new Response(wire, {
				headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-stream-success' },
			}),
	);
	const response = await infer.inject({
		method: 'POST',
		url: '/v1/responses',
		headers: { authorization: `Bearer ${key}` },
		payload: { ...payload, stream: true },
	});
	expect(response.statusCode).toBe(200);
	expect(response.headers['x-request-id']).toBe('req-stream-success');
	expect(response.body).toBe(wire);
});

it('cancels the upstream request when the n8n stream reader disconnects', async () => {
	let resolveAborted;
	const aborted = new Promise((resolve) => {
		resolveAborted = resolve;
	});
	let calls = 0;
	const { infer } = await servers(async (url, options) => {
		calls++;
		let closed = false;
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						event({
							type: 'response.created',
							response: { id: 'resp_fixture', status: 'in_progress' },
						}),
					),
				);
				options.signal.addEventListener(
					'abort',
					() => {
						if (!closed) {
							closed = true;
							controller.close();
						}
						resolveAborted();
					},
					{ once: true },
				);
			},
			cancel() {
				closed = true;
			},
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
	});
	await infer.listen({ host: '127.0.0.1', port: 0 });
	const controller = new AbortController();
	const response = await fetch(`http://127.0.0.1:${infer.server.address().port}/v1/responses`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify({ ...payload, stream: true }),
		signal: controller.signal,
	});
	const reader = response.body.getReader();
	await reader.read();
	controller.abort();
	await expect(
		Promise.race([
			aborted,
			new Promise((resolve, reject) =>
				setTimeout(() => reject(new Error('Upstream request was not cancelled')), 1500),
			),
		]),
	).resolves.toBeUndefined();
	expect(calls).toBe(1);
});
