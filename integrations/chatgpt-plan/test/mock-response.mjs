// Deterministic Responses events; no model or OpenAI connection is used.
export function mockResponse({ id, name, arguments: args, text = 'OK' }) {
	const events = [];
	const reasoning = {
		type: 'reasoning',
		id: `rs_${id}`,
		summary: [{ type: 'summary_text', text: 'Mock reasoning.' }],
		encrypted_content: `mock-encrypted-${id}`,
	};
	const item = name
		? {
				type: 'function_call',
				id: `fc_${id}`,
				call_id: `call_${id}`,
				namespace: 'n8n',
				name,
				arguments: JSON.stringify(args),
				status: 'completed',
			}
		: {
				type: 'message',
				role: 'assistant',
				id: `msg_${id}`,
				status: 'completed',
				content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
			};
	const response = {
		id: `resp_${id}`,
		object: 'response',
		created_at: 1_790_000_000,
		status: 'completed',
		model: 'gpt-6.1-sol',
		output: [reasoning, item],
		usage: {
			input_tokens: 10,
			output_tokens: 6,
			total_tokens: 16,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 2 },
		},
	};
	events.push({
		type: 'response.created',
		response: { ...response, status: 'in_progress', output: [] },
	});
	events.push({
		type: 'response.output_item.added',
		output_index: 0,
		item: { ...reasoning, summary: [], encrypted_content: null },
	});
	events.push({
		type: 'response.reasoning_summary_part.added',
		output_index: 0,
		item_id: reasoning.id,
		summary_index: 0,
		part: { type: 'summary_text', text: '' },
	});
	events.push({
		type: 'response.reasoning_summary_text.delta',
		output_index: 0,
		item_id: reasoning.id,
		summary_index: 0,
		delta: 'Mock reasoning.',
	});
	events.push({
		type: 'response.reasoning_summary_text.done',
		output_index: 0,
		item_id: reasoning.id,
		summary_index: 0,
		text: 'Mock reasoning.',
	});
	events.push({
		type: 'response.reasoning_summary_part.done',
		output_index: 0,
		item_id: reasoning.id,
		summary_index: 0,
		part: reasoning.summary[0],
	});
	events.push({ type: 'response.output_item.done', output_index: 0, item: reasoning });
	events.push({
		type: 'response.output_item.added',
		output_index: 1,
		item: { ...item, status: 'in_progress', ...(name ? { arguments: '' } : { content: [] }) },
	});
	if (name) {
		events.push({
			type: 'response.function_call_arguments.delta',
			item_id: item.id,
			output_index: 1,
			delta: item.arguments,
		});
		events.push({
			type: 'response.function_call_arguments.done',
			item_id: item.id,
			output_index: 1,
			arguments: item.arguments,
		});
	} else {
		events.push({
			type: 'response.content_part.added',
			item_id: item.id,
			output_index: 1,
			content_index: 0,
			part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
		});
		events.push({
			type: 'response.output_text.delta',
			item_id: item.id,
			output_index: 1,
			content_index: 0,
			delta: text,
			logprobs: [],
		});
		events.push({
			type: 'response.output_text.done',
			item_id: item.id,
			output_index: 1,
			content_index: 0,
			text,
			logprobs: [],
		});
		events.push({
			type: 'response.content_part.done',
			item_id: item.id,
			output_index: 1,
			content_index: 0,
			part: item.content[0],
		});
	}
	events.push({ type: 'response.output_item.done', output_index: 1, item });
	events.push({ type: 'response.completed', response });
	return new Response(
		events
			.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
			.join(''),
		{ headers: { 'Content-Type': 'text/event-stream' } },
	);
}
