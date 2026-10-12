import { createParser } from 'eventsource-parser';
import { BridgeError } from './auth.mjs';

export class UpstreamError extends Error {
	constructor(status, body, headers, secrets = []) {
		super('ChatGPT rejected the request.');
		this.status = status;
		let serialized = JSON.stringify(body);
		for (const secret of secrets) {
			if (typeof secret === 'string' && secret)
				serialized = serialized.split(secret).join('[redacted]');
		}
		this.body = JSON.parse(serialized);
		this.requestId = headers.get('x-request-id');
		this.retryAfter = headers.get('retry-after');
	}
}

// These documented plan errors keep their recovery status after an SSE stream opens.
const PLAN_ERROR_STATUS = {
	subscription_sharing_user_not_eligible: 403,
	subscription_sharing_usage_limit_exceeded: 429,
	subscription_sharing_usage_unavailable: 503,
	subscription_sharing_unsupported_capability: 400,
	subscription_sharing_route_not_supported: 403,
	subscription_sharing_invalid_user: 401,
	subscription_sharing_user_unavailable: 503,
	chatpass_v2_scope_not_authorized: 403,
	chatpass_v2_invalid_authorization_context: 403,
};

function streamFailure(value, headers, secrets) {
	const error =
		value.response?.error ??
		value.error ??
		(value.type === 'error' && typeof value.code === 'string'
			? {
					code: value.code,
					message: value.message,
					...(value.param === undefined ? {} : { param: value.param }),
				}
			: null);
	if (
		error &&
		typeof error === 'object' &&
		!Array.isArray(error) &&
		typeof error.code === 'string'
	) {
		return new UpstreamError(PLAN_ERROR_STATUS[error.code] ?? 502, { error }, headers, secrets);
	}
	return new BridgeError(502, 'inference_incomplete', 'ChatGPT did not complete the request.');
}

const ALLOWED_FIELDS = [
	'model',
	'input',
	'instructions',
	'tools',
	'tool_choice',
	'parallel_tool_calls',
	'reasoning',
	'text',
	'include',
];
const SUPPORTED_TOOLS = new Set([
	'function',
	'custom',
	'namespace',
	'web_search',
	'web_search_preview',
]);

export function normalizeRequest(request, selectedModel) {
	if (request.previous_response_id || request.conversation) {
		throw new BridgeError(
			400,
			'history_required',
			'Send the full conversation in input. Stored response IDs are not supported.',
		);
	}
	const result = Object.fromEntries(
		ALLOWED_FIELDS.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]),
	);
	result.model = request.model === 'chatgpt-plan' ? selectedModel : request.model;
	if (!result.model)
		throw new BridgeError(400, 'model_required', 'Select an available ChatGPT model.');
	const input =
		typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input;
	if (!Array.isArray(input))
		throw new BridgeError(400, 'input_required', 'Provide a Responses input array.');
	result.input = input.map((item) =>
		item?.role === 'system' ? { ...item, role: 'developer' } : item,
	);
	// Deferred tool sets can change between turns; their earlier calls still belong to n8n.
	result.input = result.input.map((item) =>
		['function_call', 'custom_tool_call'].includes(item?.type) && !item.namespace
			? { ...item, namespace: 'n8n' }
			: item,
	);
	result.store = false;
	result.stream = true;
	result.include = [...new Set([...(request.include ?? []), 'reasoning.encrypted_content'])];
	const tools = request.tools ?? [];
	if (!Array.isArray(tools) || tools.some((tool) => !SUPPORTED_TOOLS.has(tool.type))) {
		throw new BridgeError(
			400,
			'tool_unsupported',
			'This tool is not supported by ChatGPT plan inference.',
		);
	}
	const localTools = tools.filter((tool) => tool.type === 'function' || tool.type === 'custom');
	if (tools.some((tool) => tool.type === 'namespace' && tool.name === 'n8n') && localTools.length) {
		throw new BridgeError(400, 'namespace_conflict', 'The n8n tool namespace is already in use.');
	}
	if (tools.length) {
		result.tools = [
			...tools.filter((tool) => tool.type !== 'function' && tool.type !== 'custom'),
			...(localTools.length
				? [
						{
							type: 'namespace',
							name: 'n8n',
							description: 'Tools supplied and executed by n8n.',
							tools: localTools,
						},
					]
				: []),
		];
		const localNames = new Set(localTools.map((tool) => tool.name));
		result.input = result.input.map((item) =>
			item?.type === 'function_call' && localNames.has(item.name)
				? { ...item, namespace: 'n8n' }
				: item,
		);
		if (result.tool_choice?.type === 'function' && localNames.has(result.tool_choice.name)) {
			result.tool_choice = { ...result.tool_choice, namespace: 'n8n' };
		}
	}
	return result;
}

export async function collectResponse(body, { headers = new Headers(), secrets = [] } = {}) {
	let response;
	let failure;
	const parser = createParser({
		onEvent(event) {
			if (event.data === '[DONE]') return;
			let value;
			try {
				value = JSON.parse(event.data);
			} catch {
				failure ??= new BridgeError(
					502,
					'inference_incomplete',
					'ChatGPT did not complete the request.',
				);
				return;
			}
			if (value.type === 'response.completed') response = value.response;
			if (['error', 'response.failed', 'response.incomplete'].includes(value.type))
				failure ??= streamFailure(value, headers, secrets);
		},
	});
	const decoder = new TextDecoder();
	for await (const chunk of body) {
		parser.feed(decoder.decode(chunk, { stream: true }));
		if (failure) break;
	}
	parser.feed(decoder.decode());
	if (failure) throw failure;
	if (!response || response.status !== 'completed') {
		throw new BridgeError(502, 'inference_incomplete', 'ChatGPT did not complete the request.');
	}
	return response;
}
