import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export class BridgeError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export async function verifyIdentity(token, clientId, nonce, keys = JWKS) {
	const { payload } = await jwtVerify(token, keys, {
		issuer: ISSUER,
		audience: clientId,
		requiredClaims: ['sub', 'exp', 'iat'],
		clockTolerance: 5,
	});
	if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) {
		throw new BridgeError(400, 'identity_invalid', 'ChatGPT identity validation failed.');
	}
	return payload;
}

export class TokenStore {
	constructor(directory, options = {}) {
		this.directory = directory;
		this.fetch = options.fetch ?? fetch;
		this.codeExchangeFetch = options.codeExchangeFetch;
		this.verify = options.verify ?? verifyIdentity;
		this.now = options.now ?? Date.now;
		this.pending = new Map();
		this.refreshing = null;
		this.credentials = null;
	}

	async init() {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		try {
			this.hostId = (await readFile(join(this.directory, 'host-id'), 'utf8')).trim();
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			this.hostId = `urn:uuid:${randomUUID()}`;
			await this.atomicWrite('host-id', this.hostId);
		}
		try {
			this.credentials = JSON.parse(
				await readFile(join(this.directory, 'credentials.json'), 'utf8'),
			);
			if (
				!this.credentials.client_id ||
				!this.credentials.subject ||
				(!this.credentials.access_token && !this.credentials.reauthorization_required)
			) {
				throw new BridgeError(
					500,
					'credentials_invalid',
					'The saved ChatGPT connection is invalid.',
				);
			}
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		try {
			const registration = JSON.parse(
				await readFile(join(this.directory, 'retry-registration.json'), 'utf8'),
			);
			if (
				registration.host_id === this.hostId &&
				typeof registration.client_id === 'string' &&
				registration.client_id.startsWith('oaiapp_')
			)
				this.retryClientId = registration.client_id;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}

	async atomicWrite(name, value) {
		const target = join(this.directory, name);
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
		await rename(temporary, target);
	}

	async save(credentials) {
		await this.atomicWrite('credentials.json', JSON.stringify(credentials));
		this.credentials = credentials;
	}

	status() {
		return {
			authenticated: Boolean(this.credentials && !this.credentials.reauthorization_required),
			reauthorization_required: Boolean(this.credentials?.reauthorization_required),
			plan_authorized: Boolean(
				!this.credentials?.reauthorization_required &&
				this.credentials?.scopes?.includes(PLAN_SCOPE),
			),
			email: this.credentials?.email ?? null,
		};
	}

	start(redirectUri) {
		for (const [state, attempt] of this.pending) {
			if (attempt.expires < this.now()) this.pending.delete(state);
		}
		if (this.pending.size >= 8) {
			throw new BridgeError(
				429,
				'login_pending',
				'Finish a pending sign-in before starting another.',
			);
		}
		const state = randomBytes(32).toString('base64url');
		const nonce = randomBytes(32).toString('base64url');
		const verifier = randomBytes(64).toString('base64url');
		const clientId = this.credentials?.client_id ?? this.retryClientId;
		this.pending.set(state, {
			nonce,
			verifier,
			createdAt: this.now(),
			redirectUri,
			clientId,
			subject: this.credentials?.subject,
			expires: this.now() + 10 * 60_000,
		});
		const parameters = new URLSearchParams({
			client_id: clientId ?? 'dynamic_agent_client',
			ext_agent_host_id: this.hostId,
			response_type: 'code',
			redirect_uri: redirectUri,
			scope: SCOPES,
			resource: RESOURCE,
			state,
			nonce,
			code_challenge_method: 'S256',
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		});
		if (!clientId) parameters.set('agent_name_hint', 'n8n ChatGPT plan bridge');
		if (this.credentials?.id_token) parameters.set('id_token_hint', this.credentials.id_token);
		if (this.credentials && !this.credentials.scopes?.includes(PLAN_SCOPE))
			parameters.set('prompt', 'consent');
		return `${ISSUER}/api/accounts/authorize?${parameters}`;
	}

	async exchange(parameters) {
		const attempt = this.pending.get(parameters.state);
		this.pending.delete(parameters.state);
		if (!attempt || attempt.expires <= this.now()) {
			throw new BridgeError(
				400,
				'state_invalid',
				'Sign-in expired or its state did not match. Start again.',
			);
		}
		if (parameters.error) {
			throw new BridgeError(400, 'consent_declined', 'ChatGPT sign-in was not completed.');
		}
		const clientId = attempt.clientId ?? parameters.client_id;
		if (
			typeof parameters.code !== 'string' ||
			!parameters.code ||
			typeof clientId !== 'string' ||
			!clientId ||
			clientId === 'dynamic_agent_client' ||
			(attempt.clientId && parameters.client_id && parameters.client_id !== attempt.clientId)
		) {
			throw new BridgeError(
				400,
				'registration_invalid',
				'ChatGPT did not return the expected client registration.',
			);
		}
		// Keep the issued registration for invalid_grant recovery. It authorizes no inference by itself.
		this.retryClientId = clientId;
		await this.atomicWrite(
			'retry-registration.json',
			JSON.stringify({ client_id: clientId, host_id: this.hostId }),
		);
		this.exchangeContext = {
			location: this.codeExchangeFetch ? 'browser_computer' : 'vm',
			authorization_age_ms: this.now() - attempt.createdAt,
			callback_code_has_whitespace: /\s/.test(parameters.code),
		};
		const token = await this.tokenRequest({
			grant_type: 'authorization_code',
			client_id: clientId,
			code: parameters.code,
			code_verifier: attempt.verifier,
			redirect_uri: attempt.redirectUri,
			resource: RESOURCE,
		});
		const identity = await this.verify(token.id_token, clientId, attempt.nonce);
		if (attempt.subject && identity.sub !== attempt.subject) {
			throw new BridgeError(
				400,
				'account_changed',
				'Use the ChatGPT account that owns this connection.',
			);
		}
		const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : [];
		await this.save({
			model: this.credentials?.model,
			reauthorization_required: false,
			issuer: ISSUER,
			subject: identity.sub,
			email: identity.email ?? null,
			client_id: clientId,
			ext_agent_host_id: this.hostId,
			id_token: token.id_token,
			scopes,
			...this.tokenFields(token, scopes.includes(PLAN_SCOPE)),
		});
	}

	tokenFields(token, requireRefresh = true) {
		if (
			typeof token.access_token !== 'string' ||
			!token.access_token ||
			(requireRefresh && (typeof token.refresh_token !== 'string' || !token.refresh_token)) ||
			!Number.isFinite(Number(token.expires_in)) ||
			!(Number(token.expires_in) > 0)
		) {
			throw new BridgeError(
				502,
				'token_response_invalid',
				'ChatGPT returned an incomplete token response.',
			);
		}
		const earliest =
			typeof token.earliest_refresh_at === 'number'
				? token.earliest_refresh_at * 1000
				: Date.parse(token.earliest_refresh_at ?? '') || 0;
		return {
			access_token: token.access_token,
			refresh_token: token.refresh_token ?? null,
			token_type: 'Bearer',
			expires_at: this.now() + Number(token.expires_in) * 1000,
			earliest_refresh_at: earliest,
		};
	}

	async tokenRequest(parameters) {
		let response;
		const isCodeExchange = parameters.grant_type === 'authorization_code';
		// Both codes and rotating refresh tokens can be consumed by a lost response.
		const attempts = 1;
		const transport =
			isCodeExchange && this.codeExchangeFetch ? this.codeExchangeFetch : this.fetch;
		try {
			response = await transport(TOKEN_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent': 'n8n-chatgpt-plan-bridge/0.1.0',
				},
				body: new URLSearchParams(parameters),
				signal: AbortSignal.timeout(30_000),
				redirect: 'error',
			});
		} catch (error) {
			if (error instanceof BridgeError) throw error;
			throw new BridgeError(503, 'auth_unreachable', 'ChatGPT sign-in is temporarily unavailable.');
		}
		if (!response.ok) {
			let body;
			try {
				body = await response.json();
			} catch {
				body = null;
			}
			const rawCode = typeof body?.error === 'string' ? body.error : body?.error?.code;
			const knownCodes = new Set([
				'invalid_grant',
				'invalid_client',
				'invalid_scope',
				'invalid_request',
				'access_denied',
				'unauthorized_client',
				'unsupported_grant_type',
				'invalid_refresh_token',
				'token_expired',
				'refresh_token_expired',
				'refresh_token_invalidated',
				'refresh_token_reused',
				'subscription_sharing_user_not_eligible',
			]);
			const code = knownCodes.has(rawCode) ? rawCode : 'oauth_request_rejected';
			const refreshing = parameters.grant_type === 'refresh_token';
			this.lastAuthError = {
				phase: refreshing ? 'refresh' : 'code_exchange',
				http_status: response.status,
				provider_code: code,
				request_id: response.headers.get('x-request-id'),
			};
			if (!refreshing) {
				// This private diagnostic excludes the submitted code, verifier, client ID, and other grant values.
				let description =
					typeof body?.error_description === 'string'
						? body.error_description
						: typeof body?.error?.message === 'string'
							? body.error.message
							: '';
				for (const value of Object.values(parameters)) {
					if (typeof value === 'string' && value.length >= 6)
						description = description.split(value).join('[redacted]');
				}
				description = description
					.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
					.replace(/[a-zA-Z0-9_./+=-]{24,}/g, '[redacted-value]')
					.slice(0, 500);
				await this.atomicWrite(
					'last-oauth-error.json',
					JSON.stringify({
						...this.lastAuthError,
						...this.exchangeContext,
						description,
						request_id: response.headers.get('x-request-id'),
						response_fields: body && typeof body === 'object' ? Object.keys(body) : [],
						attempts,
					}),
				);
			}
			if (
				refreshing &&
				new Set([
					'invalid_grant',
					'invalid_refresh_token',
					'token_expired',
					'refresh_token_expired',
					'refresh_token_invalidated',
					'refresh_token_reused',
				]).has(code)
			) {
				// Keep the validated profile, account hint, and registration; discard unusable tokens.
				await this.save({
					...this.credentials,
					access_token: null,
					refresh_token: null,
					expires_at: 0,
					reauthorization_required: true,
				});
			}
			throw new BridgeError(
				response.status >= 500
					? 503
					: response.status === 429
						? 429
						: response.status === 403
							? 403
							: 401,
				refreshing ? 'reauthorization_required' : 'sign_in_exchange_failed',
				`ChatGPT rejected ${refreshing ? 'token renewal' : 'the sign-in code exchange'} (HTTP ${response.status}, ${code}). ${response.status >= 500 || response.status === 429 ? 'Keep this connection and try again later.' : code === 'invalid_client' ? 'Check the client configuration.' : 'Start a fresh sign-in from the local page.'}`,
			);
		}
		this.lastAuthError = null;
		try {
			return await response.json();
		} catch {
			throw new BridgeError(
				502,
				'token_response_invalid',
				'ChatGPT returned an invalid token response.',
			);
		}
	}

	async accessToken() {
		if (this.credentials?.reauthorization_required) {
			throw new BridgeError(
				401,
				'reauthorization_required',
				'This ChatGPT connection expired. Sign in again from the local page.',
			);
		}
		if (this.credentials && !this.credentials.scopes?.includes(PLAN_SCOPE)) {
			throw new BridgeError(
				403,
				'plan_not_authorized',
				'Identity sign-in succeeded, but ChatGPT plan usage is not authorized. Enable eligible plan access from the local connection page.',
			);
		}
		if (!this.credentials?.scopes?.includes(PLAN_SCOPE)) {
			throw new BridgeError(
				401,
				'chatgpt_sign_in_required',
				'Open the local sign-in page and continue with ChatGPT.',
			);
		}
		if (this.credentials.expires_at > this.now() + 60_000) return this.credentials.access_token;
		if (this.credentials.earliest_refresh_at > this.now()) {
			if (this.credentials.expires_at > this.now()) return this.credentials.access_token;
			throw new BridgeError(
				503,
				'refresh_not_ready',
				'ChatGPT token renewal is not available yet. Try again later.',
			);
		}
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	async refresh() {
		const current = this.credentials;
		const token = await this.tokenRequest({
			grant_type: 'refresh_token',
			client_id: current.client_id,
			refresh_token: current.refresh_token,
			resource: RESOURCE,
		});
		const scopes = token.scope ? token.scope.split(/\s+/) : current.scopes;
		if (!scopes.includes(PLAN_SCOPE)) {
			throw new BridgeError(
				403,
				'plan_not_authorized',
				'ChatGPT plan access is no longer granted.',
			);
		}
		if (token.id_token) {
			const identity = await this.verify(token.id_token, current.client_id);
			if (identity.sub !== current.subject) {
				throw new BridgeError(
					401,
					'account_changed',
					'ChatGPT returned a different account. Sign in again.',
				);
			}
		}
		await this.save({
			...current,
			...this.tokenFields(token),
			scopes,
			id_token: token.id_token ?? current.id_token,
		});
		return this.credentials.access_token;
	}
}
