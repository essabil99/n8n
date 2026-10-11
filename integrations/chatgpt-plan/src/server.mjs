import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { BridgeError, RESOURCE } from './auth.mjs';
import { normalizeRequest, collectResponse } from './protocol.mjs';

const REQUEST_SCHEMA = {
	type: 'object',
	required: ['model', 'input'],
	properties: {
		model: { type: 'string', minLength: 1, maxLength: 128 },
		input: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
		stream: { type: 'boolean' },
		tools: {
			type: 'array',
			items: { type: 'object', required: ['type'], properties: { type: { type: 'string' } } },
		},
		include: { type: 'array', items: { type: 'string' } },
	},
	additionalProperties: true,
};

class UpstreamError extends Error {
	constructor(status, body, headers) {
		super('ChatGPT rejected the request.');
		this.status = status;
		this.body = body;
		this.requestId = headers.get('x-request-id');
		this.retryAfter = headers.get('retry-after');
	}
}

function errorHandler(error, request, reply) {
	if (error instanceof UpstreamError) {
		if (error.requestId) reply.header('X-Request-Id', error.requestId);
		if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
		return reply.code(error.status).send(error.body);
	}

	if (error instanceof BridgeError) {
		if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
		return reply
			.code(error.status)
			.send({ error: { type: 'chatgpt_plan_error', code: error.code, message: error.message } });
	}
	const status = error.validation
		? 400
		: error.statusCode >= 400 && error.statusCode < 500
			? error.statusCode
			: 502;
	return reply.code(status).send({
		error: {
			type: 'chatgpt_plan_error',
			code: 'request_failed',
			message:
				status === 400
					? 'The request format is invalid.'
					: 'The bridge could not complete this request.',
		},
	});
}

export async function createServers({
	store,
	apiKey,
	fetchImpl = fetch,
	redirectUri = 'http://127.0.0.1:1455/auth/callback',
	model = 'gpt-6.1-sol',
}) {
	if (!apiKey || apiKey.length < 24)
		throw new Error('CHATGPT_BRIDGE_API_KEY must contain at least 24 characters.');
	const infer = Fastify({
		logger: false,
		bodyLimit: 32 * 1024 * 1024,
		requestTimeout: 300_000,
		ajv: { customOptions: { coerceTypes: false } },
	});
	const admin = Fastify({
		logger: false,
		bodyLimit: 16_384,
		ajv: { customOptions: { coerceTypes: false } },
	});
	infer.setErrorHandler(errorHandler);
	admin.setErrorHandler(errorHandler);
	const expected = createHash('sha256').update(`Bearer ${apiKey}`).digest();
	infer.addHook('onRequest', async (request, reply) => {
		if (request.url === '/healthz') return;
		const provided = createHash('sha256')
			.update(request.headers.authorization ?? '')
			.digest();
		if (!timingSafeEqual(expected, provided)) {
			return reply.code(401).send({
				error: { code: 'bridge_key_required', message: 'The bridge API key is required.' },
			});
		}
	});
	admin.addHook('onRequest', async (request, reply) => {
		const callback = new URL(redirectUri);
		const localHosts = new Set([callback.host, `localhost:${callback.port}`]);
		const localOrigins = new Set([callback.origin, `http://localhost:${callback.port}`]);
		if (
			!localHosts.has(request.headers.host) ||
			(request.method === 'POST' && !localOrigins.has(request.headers.origin))
		) {
			return reply
				.code(403)
				.send({ error: { code: 'local_origin_required', message: 'Use the local sign-in page.' } });
		}
		reply.header('Cache-Control', 'no-store');
		reply.header('Referrer-Policy', 'no-referrer');
		reply.header('X-Content-Type-Options', 'nosniff');
		reply.header(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
		);
	});

	async function call(path, options = {}) {
		const token = await store.accessToken();
		let response;
		try {
			response = await fetchImpl(`${RESOURCE}${path}`, {
				...options,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`,
					'User-Agent': 'n8n-chatgpt-plan-bridge/0.1.0',
					...options.headers,
				},
				signal: options.signal ?? AbortSignal.timeout(30_000),
			});
		} catch {
			throw new BridgeError(
				503,
				'openai_unreachable',
				'ChatGPT inference is temporarily unavailable.',
			);
		}
		if (!response.ok) {
			// Preserve provider codes, params, and admission detail bodies for n8n's error handling.
			let body;
			try {
				const text = (await response.text())
					.split(token)
					.join('[redacted]')
					.split(apiKey)
					.join('[redacted]');
				body = JSON.parse(text);
			} catch {
				body = {
					error: { code: 'chatgpt_request_rejected', message: 'ChatGPT rejected this request.' },
				};
			}
			throw new UpstreamError(response.status, body, response.headers);
		}

		return response;
	}

	async function catalog() {
		const response = await call('/models');
		let value;
		try {
			value = await response.json();
		} catch {
			throw new BridgeError(502, 'models_invalid', 'ChatGPT returned an invalid model catalog.');
		}
		if (!Array.isArray(value.models))
			throw new BridgeError(
				502,
				'models_invalid',
				'ChatGPT did not return its plan model catalog.',
			);
		return value.models.filter(
			(item) => item.visibility === 'list' && typeof item.slug === 'string',
		);
	}

	infer.get('/healthz', async () => ({ status: 'ok', ...store.status() }));
	infer.get('/v1/models', async () => ({
		object: 'list',
		data: [
			{ id: 'chatgpt-plan', object: 'model', owned_by: 'chatgpt-plan' },
			...(await catalog()).map((item) => ({ id: item.slug, object: 'model', owned_by: 'openai' })),
		],
	}));
	infer.post('/v1/responses', { schema: { body: REQUEST_SCHEMA } }, async (request, reply) => {
		const normalized = normalizeRequest(request.body, store.credentials?.model ?? model);
		const controller = new AbortController();
		reply.raw.once('close', () => {
			if (!reply.raw.writableFinished) controller.abort();
		});
		const upstream = await call('/responses', {
			method: 'POST',
			body: JSON.stringify(normalized),
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
		});
		if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
			await upstream.body?.cancel();
			throw new BridgeError(
				502,
				'stream_required',
				'ChatGPT did not return the required response stream.',
			);
		}
		if (request.body.stream) {
			return reply
				.header('Content-Type', 'text/event-stream')
				.header('Cache-Control', 'no-store')
				.send(Readable.fromWeb(upstream.body));
		}
		return collectResponse(upstream.body);
	});
	admin.get('/', async (request, reply) =>
		reply.type('text/html').send(await readFile(new URL('./index.html', import.meta.url), 'utf8')),
	);
	admin.get('/app.js', async (request, reply) =>
		reply
			.type('text/javascript')
			.send(await readFile(new URL('./app.js', import.meta.url), 'utf8')),
	);
	admin.get('/auth/status', async () => ({
		...store.status(),
		model: store.credentials?.model ?? model,
		last_auth_error: store.lastAuthError ?? null,
	}));
	admin.post('/auth/start', async () => ({ url: store.start(redirectUri) }));
	admin.get('/auth/callback', async (request, reply) => {
		await store.exchange(request.query);
		return reply.redirect('/?connected=1');
	});
	admin.get('/auth/models', async () => ({ models: await catalog() }));
	admin.post(
		'/auth/model',
		{
			schema: {
				body: {
					type: 'object',
					required: ['model'],
					additionalProperties: false,
					properties: { model: { type: 'string', minLength: 1, maxLength: 128 } },
				},
			},
		},
		async (request) => {
			if (!(await catalog()).some((item) => item.slug === request.body.model)) {
				throw new BridgeError(
					400,
					'model_unavailable',
					'Choose a model from this account’s catalog.',
				);
			}
			await store.save({ ...store.credentials, model: request.body.model });
			return { model: request.body.model };
		},
	);
	return { infer, admin };
}
