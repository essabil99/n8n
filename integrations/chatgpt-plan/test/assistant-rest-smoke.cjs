// Run on the VM against a disposable n8n database, using the real Assistant REST service.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const base = 'http://n8n-assistant-smoke:5678';
const bridge = 'http://n8n-chatgpt-sdk-smoke:3210';
const key = 'mock-bridge-key-with-more-than-24-characters';
let cookie;
async function request(path, body, method) {
	const response = await fetch(base + path, {
		method: method ?? (body === undefined ? 'GET' : 'POST'),
		headers: {
			'Content-Type': 'application/json',
			Origin: base,
			...(cookie ? { Cookie: cookie } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const setCookie = response.headers.get('set-cookie');
	if (setCookie) cookie = setCookie.split(';')[0];
	const raw = await response.text();
	let result;
	try {
		result = JSON.parse(raw);
	} catch {
		throw new Error(`${path}: HTTP ${response.status}: ${raw.slice(0, 200)}`);
	}
	assert.ok(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
	return result.data ?? result;
}
async function listen(threadId, signal, events) {
	const response = await fetch(`${base}/rest/instance-ai/events/${threadId}`, {
		headers: { Cookie: cookie },
		signal,
	});
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type'), /text\/event-stream/);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			events.push(decoder.decode(value));
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	}
}
function expectedText(message) {
	if (message.includes('ASSISTANT_BUILD_SMOKE')) return 'Assistant sandbox build completed.';
	if (message.includes('FOLLOWUP')) return 'Previous workflow result remembered.';
	return 'Assistant workflow tool completed.';
}

async function run(threadId, message) {
	const events = [];
	const controller = new AbortController();
	const listening = listen(threadId, controller.signal, events);
	const started = await request(`/rest/instance-ai/chat/${threadId}`, {
		message,
		timeZone: 'Africa/Casablanca',
	});
	assert.ok(started.runId);
	let messages;
	let finished = false;
	for (let index = 0; index < 120; index++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		messages = await request(`/rest/instance-ai/threads/${threadId}/messages`);
		const text = JSON.stringify(messages);
		if (text.includes(expectedText(message))) {
			finished = true;
			break;
		}
		if (index === 119)
			console.log(
				'Last thread status:',
				JSON.stringify(await request(`/rest/instance-ai/threads/${threadId}/status`)),
			);
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
	controller.abort();
	await listening;
	assert.ok(finished, 'The real Assistant did not finish the requested turn.');
	const frames = events
		.join('')
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSON.parse(line.slice(6)));
	const deltas = frames.filter((frame) => frame.type === 'text-delta');
	const streamed = deltas
		.map((frame) => frame.payload?.text ?? frame.delta ?? frame.text ?? '')
		.join('');
	if (!streamed.includes(expectedText(message)))
		console.log('SSE diagnostic:', JSON.stringify(deltas).slice(-2500));
	assert.ok(
		streamed.includes(expectedText(message)),
		'Assistant SSE did not contain the response text',
	);

	return messages;
}
async function checkNativeSettings() {
	const routes = [
		['GET', 'status'],
		['POST', 'start'],
		['GET', 'models'],
		['POST', 'model'],
	];
	for (const [method, action] of routes) {
		const response = await fetch(base + '/rest/instance-ai/settings/chatgpt/' + action, {
			method,
			headers: { 'Content-Type': 'application/json', Origin: base },
			...(method === 'POST' ? { body: '{}' } : {}),
		});
		assert.equal(response.status, 401, 'Anonymous native settings access was allowed.');
	}
	const settings = await request('/rest/instance-ai/settings');
	assert.equal(settings.chatgptPlan.plan_authorized, true);
	assert.equal(settings.chatgptPlan.model, 'gpt-6.1-sol');
	assert.ok(!JSON.stringify(settings).includes(key));
	const models = await request('/rest/instance-ai/settings/chatgpt/models');
	assert.equal(models.models.length, 2);
	await request('/rest/instance-ai/settings/chatgpt/model', { model: 'fixture-second' });
	assert.equal(
		(await request('/rest/instance-ai/settings/chatgpt/status')).model,
		'fixture-second',
	);
	await request('/rest/instance-ai/settings/chatgpt/model', { model: 'gpt-6.1-sol' });
	const ownerCookie = cookie;
	const invitations = await request('/rest/invitations', [
		{ email: 'native-member@example.invalid', role: 'global:member' },
	]);
	const invitation = invitations[0].user;
	assert.equal(invitation.emailSent, false, 'This disposable test must not send email.');
	const token = new URL(invitation.inviteAcceptUrl).searchParams.get('token');
	await request('/rest/invitations/accept', {
		token,
		firstName: 'Native',
		lastName: 'Member',
		password: 'Smoke9!' + randomBytes(16).toString('hex'),
	});
	for (const [method, action] of routes) {
		const response = await fetch(base + '/rest/instance-ai/settings/chatgpt/' + action, {
			method,
			headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
			...(method === 'POST' ? { body: '{}' } : {}),
		});
		assert.equal(response.status, 403, 'A member changed the shared ChatGPT connection.');
	}
	cookie = ownerCookie;
	console.log(
		'Native owner settings, safe status, catalog, model selection, anonymous/member permissions: passed',
	);
}
async function main() {
	await request('/rest/owner/setup', {
		email: 'oauth-smoke@example.invalid',
		firstName: 'OAuth',
		lastName: 'Smoke',
		password: 'Smoke9!' + randomBytes(16).toString('hex'),
	});
	console.log('Disposable n8n owner setup: passed');
	await checkNativeSettings();
	const projectId = (await request('/rest/projects/personal')).id;
	await request('/rest/workflows', {
		name: 'OAuth smoke workflow',
		nodes: [
			{
				id: randomUUID(),
				name: 'Manual Trigger',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			},
		],
		connections: {},
		settings: { executionOrder: 'v1' },
	});
	const thread = await request('/rest/instance-ai/threads', {
		projectId,
		source: 'assistant_page',
	});
	const threadId = thread.threadId ?? thread.id ?? thread.thread?.id ?? thread.thread?.threadId;
	assert.ok(threadId, `Unexpected thread response: ${JSON.stringify(thread)}`);
	await run(threadId, 'ASSISTANT_WORKFLOW_SMOKE: list my workflows through the available tools.');
	console.log('Actual Assistant REST + SSE + search_tools/load_tool + workflow adapter: passed');
	const messages = await run(
		threadId,
		'FOLLOWUP_SMOKE: use the earlier workflow result from this conversation.',
	);
	assert.ok(JSON.stringify(messages).includes('OAuth smoke workflow'));
	console.log('SQLite conversation persistence and encrypted reasoning replay: passed');
	const buildThread = await request('/rest/instance-ai/threads', {
		projectId,
		source: 'assistant_page',
	});
	await run(
		buildThread.thread.id,
		'ASSISTANT_BUILD_SMOKE: create a manual-trigger workflow through the sandbox builder.',
	);
	const workflows = await request('/rest/workflows');
	assert.ok(
		JSON.stringify(workflows).includes('OAuth built workflow'),
		'The built workflow is missing from the real n8n database',
	);
	console.log('Real sandbox TypeScript compilation + build-workflow + SQLite save: passed');
	const status = await fetch(bridge + '/smoke-status', {
		headers: { Authorization: `Bearer ${key}` },
	}).then((response) => response.json());
	assert.equal(status.planLimits, 1);
	assert.equal(status.workflowResults, 1);
	assert.equal(status.buildResults, 1);
	assert.ok(status.toolCalls.includes('load_tool'));
	assert.equal(status.followups, 1);
	assert.ok(status.reasoningReplays >= 3);
	assert.ok(status.rawStoreFalse >= status.workflowResults + status.followups);
	assert.deepEqual(status.errors, []);
	assert.ok(
		status.reasoningEfforts.includes('high'),
		'n8n Assistant reasoning effort was dropped by the SDK',
	);
	console.log('Mock provider contract:', JSON.stringify(status));
	await request('/rest/instance-ai/threads/' + threadId, undefined, 'DELETE');
	await request('/rest/instance-ai/threads/' + buildThread.thread.id, undefined, 'DELETE');
	console.log('Disposable Assistant threads and sandbox workspaces removed.');
}
main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
