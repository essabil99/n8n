// Exercises the real bridge without contacting OpenAI or loading account credentials.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, PLAN_SCOPE } from '../src/auth.mjs';
import { createServers } from '../src/server.mjs';
import { mockPlanLimit } from './mock-response.mjs';

const directory = await mkdtemp(join(tmpdir(), 'n8n-sdk-smoke-'));
const store = new TokenStore(directory);
await store.init();
await store.save({
	subject: 'mock-account',
	client_id: 'oaiapp_mock',
	scopes: [PLAN_SCOPE],
	access_token: 'mock-oauth-access',
	refresh_token: 'mock-refresh',
	expires_at: Date.now() + 3_600_000,
});
let requests = 0;
let planLimits = 0;
const upstream = async (url, options) => {
	assert.equal(url, 'https://api.openai.com/v1/responses');
	assert.equal(options.headers.Authorization, 'Bearer mock-oauth-access');
	const body = JSON.parse(options.body);
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal(body.model, 'gpt-6.1-sol');
	assert.equal(body.max_output_tokens, undefined);
	assert.equal(body.previous_response_id, undefined);
	requests++;
	if (JSON.stringify(body.input).includes('PROBE_STREAM_LIMIT')) {
		planLimits++;
		return mockPlanLimit();
	}
	const isTool = body.tools?.length > 0;
	const hasOutput = body.input.some((item) => item.type === 'function_call_output');
	if (isTool) {
		assert.equal(body.tools[0].type, 'namespace');
		assert.equal(body.tools[0].name, 'n8n');
		assert.equal(body.tools[0].tools[0].name, 'echo');
	}
	if (hasOutput) {
		const call = body.input.find((item) => item.type === 'function_call');
		assert.equal(call.namespace, 'n8n');
		assert.match(
			body.input.find((item) => item.type === 'function_call_output').output,
			/seen:hello/,
		);
	}
	const functionCall = isTool && !hasOutput;
	const text = isTool ? 'tool-complete' : 'OK';
	const item = functionCall
		? {
				type: 'function_call',
				id: 'fc_mock',
				call_id: 'call_mock',
				namespace: 'n8n',
				name: 'echo',
				arguments: '{"message":"hello"}',
				status: 'completed',
			}
		: {
				type: 'message',
				role: 'assistant',
				id: 'msg_mock',
				status: 'completed',
				content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
			};
	const response = {
		id: `resp_mock_${requests}`,
		object: 'response',
		created_at: 1_790_000_000,
		status: 'completed',
		model: 'gpt-6.1-sol',
		output: [item],
		usage: {
			input_tokens: 10,
			output_tokens: 4,
			total_tokens: 14,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	const events = [
		{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
		{
			type: 'response.output_item.added',
			output_index: 0,
			item: {
				...item,
				status: 'in_progress',
				...(functionCall ? { arguments: '' } : { content: [] }),
			},
		},
	];
	if (functionCall) {
		events.push({
			type: 'response.function_call_arguments.delta',
			item_id: item.id,
			output_index: 0,
			delta: item.arguments,
		});
		events.push({
			type: 'response.function_call_arguments.done',
			item_id: item.id,
			output_index: 0,
			arguments: item.arguments,
		});
	} else {
		events.push({
			type: 'response.content_part.added',
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
		});
		events.push({
			type: 'response.output_text.delta',
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: text,
			logprobs: [],
		});
		events.push({
			type: 'response.output_text.done',
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			text,
			logprobs: [],
		});
		events.push({
			type: 'response.content_part.done',
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: item.content[0],
		});
	}
	events.push({ type: 'response.output_item.done', output_index: 0, item });
	events.push({ type: 'response.completed', response });
	return new Response(
		events
			.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
			.join(''),
		{ headers: { 'Content-Type': 'text/event-stream' } },
	);
};
const { infer } = await createServers({
	store,
	apiKey: process.env.CHATGPT_BRIDGE_API_KEY,
	fetchImpl: upstream,
});
infer.addHook('onError', async (request, reply, error) => {
	if (error.body?.error?.code === 'subscription_sharing_usage_limit_exceeded') return;
	console.error(
		'Mock request failure:',
		request.url,
		error.message,
		JSON.stringify(error.validation),
	);
	console.error('Mock request body:', JSON.stringify(request.body));
});
infer.get('/smoke-status', async () => ({ requests, planLimits }));
await infer.listen({ host: '0.0.0.0', port: 3210 });
