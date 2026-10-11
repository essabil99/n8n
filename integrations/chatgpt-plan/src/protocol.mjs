import { createParser } from 'eventsource-parser';
import { BridgeError } from './auth.mjs';

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

export async function collectResponse(body) {
	let response;
	let failure;
	const parser = createParser({
		onEvent(event) {
			if (event.data === '[DONE]') return;
			let value;
			try {
				value = JSON.parse(event.data);
			} catch {
				failure = true;
				return;
			}
			if (value.type === 'response.completed') response = value.response;
			if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) failure = true;
		},
	});
	const decoder = new TextDecoder();
	for await (const chunk of body) parser.feed(decoder.decode(chunk, { stream: true }));
	parser.feed(decoder.decode());
	if (failure || !response || response.status !== 'completed') {
		throw new BridgeError(502, 'inference_incomplete', 'ChatGPT did not complete the request.');
	}
	return response;
}
