import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, PLAN_SCOPE } from '../src/auth.mjs';
import { createServers } from '../src/server.mjs';
import { mockResponse, mockPlanLimit } from './mock-response.mjs';

const directory = await mkdtemp(join(tmpdir(), 'n8n-assistant-mock-'));
const store = new TokenStore(directory);
await store.init();
await store.save({
	subject: 'mock-account',
	model: 'gpt-6.1-sol',
	client_id: 'oaiapp_mock',
	scopes: [PLAN_SCOPE],
	access_token: 'mock-oauth-access',
	refresh_token: 'mock-refresh',
	expires_at: Date.now() + 3600_000,
});
const status = {
	requests: 0,
	reasoningReplays: 0,
	workflowResults: 0,
	buildResults: 0,
	followups: 0,
	rawStoreFalse: 0,
	planLimits: 0,
	reasoningEfforts: [],
	errors: [],
	toolCalls: [],
};
const upstream = async (url, options) => {
	if (url === 'https://api.openai.com/v1/models')
		return Response.json({
			models: [
				{ slug: 'gpt-6.1-sol', display_name: 'Fixture model', visibility: 'list' },
				{ slug: 'fixture-second', display_name: 'Second fixture', visibility: 'list' },
			],
		});
	assert.equal(url, 'https://api.openai.com/v1/responses');
	assert.equal(options.headers.Authorization, 'Bearer mock-oauth-access');
	const body = JSON.parse(options.body);
	const id = ++status.requests;
	if (body.reasoning?.effort) status.reasoningEfforts.push(body.reasoning.effort);
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal(body.model, 'gpt-6.1-sol');
	assert.equal(body.previous_response_id, undefined);
	assert.equal(body.max_output_tokens, undefined);
	assert.ok(body.input.every((item) => item.role !== 'system'));
	assert.ok(
		body.input.every((item) => item.type !== 'item_reference'),
		'n8n sent stored item references instead of full history',
	);
	status.reasoningReplays += body.input.filter(
		(item) => item.type === 'reasoning' && item.encrypted_content?.startsWith('mock-encrypted-'),
	).length;
	const tools = body.tools?.flatMap((tool) => (tool.type === 'namespace' ? tool.tools : [])) ?? [];
	const names = new Set(tools.map((tool) => tool.name));
	const calls = body.input.filter((item) => item.type === 'function_call');
	const outputs = body.input.filter((item) => item.type === 'function_call_output');
	for (const call of calls) assert.equal(call.namespace, 'n8n');
	const text = body.input
		.filter((item) => item.role === 'user')
		.map((item) =>
			typeof item.content === 'string'
				? item.content
				: item.content?.map((part) => part.text ?? '').join(''),
		)
		.join('\n');
	if (text.includes('PROBE_STREAM_LIMIT')) {
		status.planLimits++;
		return mockPlanLimit();
	}
	const call = (name, args) => {
		assert.ok(names.has(name), `Required tool missing: ${name}`);
		status.toolCalls.push(name);
		return mockResponse({ id, name, arguments: args });
	};
	if (names.has('echo'))
		return outputs.length
			? mockResponse({ id, text: 'tool-complete' })
			: call('echo', { message: 'hello' });
	if (names.size && text.includes('ASSISTANT_BUILD_SMOKE')) {
		const called = new Set(calls.map((item) => item.name));
		if (!called.has('search_tools')) return call('search_tools', { query: 'build-workflow' });
		if (!called.has('load_tool') && names.has('load_tool'))
			return call('load_tool', { toolName: 'build-workflow' });
		if (!called.has('build-workflow'))
			return call('build-workflow', {
				filePath: 'src/workflows/oauth-smoke.workflow.ts',
				name: 'OAuth built workflow',
				approvalSummary: 'Create a manual-trigger workflow in this disposable test instance.',
				sourceCode: `import { workflow, trigger } from '@n8n/workflow-sdk';
export default workflow('oauth-smoke', 'OAuth built workflow').add(trigger({
 type: 'n8n-nodes-base.manualTrigger', version: 1, config: {name:'Manual Trigger',parameters:{}}
}));`,
			});
		const buildCall = calls.find((item) => item.name === 'build-workflow');
		const output = outputs.find((item) => item.call_id === buildCall.call_id);
		const serialized =
			typeof output.output === 'string'
				? output.output
				: Array.isArray(output.output)
					? output.output.find(
							(part) => typeof part.text === 'string' && part.text.trim().startsWith('{'),
						)?.text
					: JSON.stringify(output.output);
		const result = JSON.parse(serialized);
		assert.equal(
			result.success,
			true,
			'Real sandbox workflow build failed: ' + JSON.stringify(result),
		);
		assert.ok(result.workflowId, 'Built workflow was not saved');
		status.buildResults++;
		return mockResponse({ id, text: 'Assistant sandbox build completed.' });
	}
	if (names.size && text.includes('FOLLOWUP_SMOKE')) {
		assert.ok(
			outputs.some((item) => item.output.includes('OAuth smoke workflow')),
			'SQLite-backed conversation did not retain earlier tool results',
		);
		status.followups++;
		return mockResponse({ id, text: 'Previous workflow result remembered.' });
	}
	if (names.size && text.includes('ASSISTANT_WORKFLOW_SMOKE')) {
		const called = new Set(calls.map((item) => item.name));
		if (!called.has('search_tools')) return call('search_tools', { query: 'workflows' });
		if (!called.has('load_tool') && names.has('load_tool'))
			return call('load_tool', { toolName: 'workflows' });
		if (!called.has('workflows')) return call('workflows', { action: 'list', limit: 2 });
		assert.ok(
			outputs.some((item) => item.output.includes('OAuth smoke workflow')),
			'The real workflow adapter did not return the seeded workflow',
		);
		status.workflowResults++;
		return mockResponse({ id, text: 'Assistant workflow tool completed.' });
	}
	return mockResponse({ id, text: names.size ? 'Assistant connected.' : 'OK' });
};
const { infer } = await createServers({
	store,
	apiKey: process.env.CHATGPT_BRIDGE_API_KEY,
	fetchImpl: async (...args) => {
		try {
			return await upstream(...args);
		} catch (error) {
			status.errors.push(error.message);
			console.error('Upstream mock contract:', error.message);
			throw error;
		}
	},
});
infer.addHook('preHandler', async (request) => {
	if (request.url === '/v1/responses' && request.body.store === false) status.rawStoreFalse++;
});
infer.addHook('onError', async (request, reply, error) => {
	if (error.body?.error?.code === 'subscription_sharing_usage_limit_exceeded') return;
	status.errors.push(error.message);
	console.error('Mock contract failure:', error.message);
});
infer.get('/smoke-status', async () => status);
await infer.listen({ host: '0.0.0.0', port: 3210 });
