import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, PLAN_SCOPE } from '../src/auth.mjs';
import { createServers } from '../src/server.mjs';
import { normalizeRequest } from '../src/protocol.mjs';

const directories = [];
const servers = [];
afterEach(async () => {
	for (const app of servers.splice(0)) await app.close();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
it('keeps historical tool namespaces after a deferred tool is removed from the current tool set', () => {
	const result = normalizeRequest({
		model: 'test',
		input: [
			{ type: 'function_call', name: 'previous_tool', call_id: 'previous', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'previous', output: 'done' },
		],
		tools: [],
	});
	expect(result.input[0].namespace).toBe('n8n');
});
it('preserves provider statuses, error shapes, codes, params, request IDs, and retry delay', async () => {
	const key = 'test-key-with-at-least-24-characters';
	for (const [status, body] of [
		[
			429,
			{
				error: {
					code: 'subscription_sharing_usage_limit_exceeded',
					message: 'Limit reached',
					param: null,
				},
			},
		],
		[
			400,
			{
				error: {
					code: 'subscription_sharing_unsupported_capability',
					message: 'Unsupported',
					param: 'tools',
				},
			},
		],
		[403, { detail: 'Region admission denied' }],
	]) {
		const path = await mkdtemp(join(tmpdir(), 'n8n-errors-'));
		directories.push(path);
		const store = new TokenStore(path);
		await store.init();
		await store.save({
			scopes: [PLAN_SCOPE],
			access_token: 'test-access',
			expires_at: Date.now() + 3600_000,
		});
		const apps = await createServers({
			store,
			apiKey: key,
			fetchImpl: async () =>
				Response.json(body, {
					status,
					headers: { 'x-request-id': 'req_test', 'retry-after': '25' },
				}),
		});
		servers.push(apps.infer, apps.admin);
		const response = await apps.infer.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: `Bearer ${key}` },
			payload: { model: 'test', input: 'hello' },
		});
		expect(response.statusCode).toBe(status);
		expect(response.json()).toEqual(body);
		expect(response.headers['x-request-id']).toBe('req_test');
		expect(response.headers['retry-after']).toBe('25');
	}
});

it('accepts n8n attachment-sized requests and preserves embedded content', async () => {
	const path = await mkdtemp(join(tmpdir(), 'n8n-attachments-'));
	directories.push(path);
	const store = new TokenStore(path);
	await store.init();
	await store.save({
		scopes: [PLAN_SCOPE],
		access_token: 'test-access',
		expires_at: Date.now() + 3600_000,
	});
	const file = 'A'.repeat(16 * 1024 * 1024);
	let received;
	const apps = await createServers({
		store,
		apiKey: 'test-key-with-at-least-24-characters',
		fetchImpl: async (_, options) => {
			received = JSON.parse(options.body);
			return new Response(
				'data: ' +
					JSON.stringify({
						type: 'response.completed',
						response: { id: 'fixture', object: 'response', status: 'completed', output: [] },
					}) +
					'\n\n',
				{ headers: { 'content-type': 'text/event-stream' } },
			);
		},
	});
	servers.push(apps.infer, apps.admin);
	const response = await apps.infer.inject({
		method: 'POST',
		url: '/v1/responses',
		headers: { authorization: 'Bearer test-key-with-at-least-24-characters' },
		payload: {
			model: 'chatgpt-plan',
			input: [
				{
					role: 'user',
					content: [
						{
							type: 'input_file',
							filename: 'fixture.txt',
							file_data: 'data:text/plain;base64,' + file,
						},
					],
				},
			],
		},
	});
	expect(response.statusCode).toBe(200);
	expect(received.input[0].content[0].file_data.length).toBe(
		file.length + 'data:text/plain;base64,'.length,
	);
});
