// Run inside the pinned n8n image to verify its real model factory and AI SDK.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireN8n = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const { createModel } = requireN8n('@n8n/agents');
const { generateText, streamText, tool, jsonSchema, stepCountIs } = requireN8n('ai');
async function main() {
	const apiKey = process.env.SMOKE_API_KEY || 'mock-bridge-key-with-more-than-24-characters';
	const url = process.env.SMOKE_BRIDGE_URL || 'http://n8n-chatgpt-sdk-smoke:3210/v1';
	const model = createModel({ id: 'openai/chatgpt-plan', url, apiKey });
	const probe = await generateText({ model, prompt: 'PROBE', maxOutputTokens: 16, maxRetries: 0 });
	assert.equal(probe.text, 'OK');
	console.log('n8n setup probe: passed');
	let executions = 0;
	const result = streamText({
		model,
		prompt: 'Use echo with message hello, then report its result.',
		maxRetries: 0,
		stopWhen: stepCountIs(2),
		tools: {
			echo: tool({
				description: 'Echo a test message.',
				inputSchema: jsonSchema({
					type: 'object',
					properties: { message: { type: 'string' } },
					required: ['message'],
					additionalProperties: false,
				}),
				execute: async ({ message }) => {
					executions++;
					return `seen:${message}`;
				},
			}),
		},
	});
	let streamed = '';
	for await (const chunk of result.textStream) streamed += chunk;
	assert.equal(streamed, 'tool-complete');
	assert.equal(executions, 1);
	const steps = await result.steps;
	assert.equal(steps.length, 2);
	console.log('n8n streamed tool round trip: passed');
	await assert.rejects(
		generateText({ model, prompt: 'PROBE_STREAM_LIMIT', maxRetries: 0 }),
		(error) => {
			assert.equal(error.statusCode, 429);
			assert.equal(error.responseHeaders['x-request-id'], 'req-mock-plan-limit');
			assert.equal(error.responseHeaders['retry-after'], '120');
			assert.equal(
				JSON.parse(error.responseBody).error.code,
				'subscription_sharing_usage_limit_exceeded',
			);
			return true;
		},
	);
	console.log('Real n8n model setup surfaces streamed plan limits and request IDs: passed');
	const status = await fetch(url.replace('/v1', '/smoke-status'), {
		headers: { Authorization: `Bearer ${apiKey}` },
	}).then((r) => r.json());
	assert.equal(status.requests, 4);
	assert.equal(status.planLimits, 1);
	console.log('Four requests used Responses, including one preserved plan-limit failure.');
}
main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
