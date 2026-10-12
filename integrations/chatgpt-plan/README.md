# ChatGPT plan connection for n8n Assistant

This experimental integration connects self-hosted n8n Assistant to ChatGPT plan usage through documented OpenAI OAuth. Requests use the subscription's limits; there is no billable API-key fallback.

## Deployment

The stack uses n8n 2.42.6 with a small, version-checked runtime overlay. The matching source changes are in the agents model factory and instance-ai workspace file helpers. A full monorepo build is unnecessary for this pinned deployment. Review the overlay before changing n8n versions; it deliberately fails on a different version or factory layout.

Use Node 24+, Docker Compose, and a private environment file outside the fork. Copy `.env.example`, generate a distinct random value for every secret, and create `CHATGPT_AUTH_DIR` owned by UID 1000 with mode `0700`. Set `N8N_BIND_IP` to a private interface; the default is loopback.

```sh
docker compose --env-file /absolute/private/path/stack.env up -d --build
docker compose --env-file /absolute/private/path/stack.env ps
```

This project has its own SQLite volume. Sandbox ports are internal. The privileged Docker-in-Docker runner executes n8n's local workflow tools. HTTP and insecure cookies are development settings; use TLS and secure cookies for an internet deployment. OAuth credentials are mounted only into the bridge.

## Connect

Create the n8n owner account first. The Assistant endpoint is configured at startup, while ChatGPT authorization is a separate operator action. This prototype has one ChatGPT connection shared by everyone with Assistant access in the instance.

For this Windows-to-VM deployment, run both the tunnel and the OAuth controller on the browser computer. Initial code exchange happens there, and its protected result returns over SSH. Identity validation, token storage, refresh, n8n, and inference stay on the VM. This follows the [VM sign-in guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

```sh
ssh -N -L 1455:127.0.0.1:1455 saad@100.64.63.105
```

The controller requires Python 3.10+, Paramiko, a trusted SSH host key, and `N8N_VM_PASSWORD` in its process environment. Its VM address, username, and private directory are the constants in `tools/local-oauth-controller.py`; adapt them for another deployment. Keep it running during sign-in:

```sh
python tools/local-oauth-controller.py
```

Open `http://127.0.0.1:1455`, choose **Continue with ChatGPT**, complete authorization, and select a model. Use a reasoning model supporting text and local function tools; the default is `gpt-6.1-sol`. The alias forces the SDK's reasoning model behavior. Return to n8n Assistant and send a small request after the page confirms a saved, authorized connection.

OpenAI documents this third-party capability for eligible Plus and Pro users. Free access is not documented, and account, workspace, rollout, model, and region policies still apply. See the [release details](https://learn.chatgpt.com/docs/whats-new/devday-2026).

## Authentication and recovery

Registration uses `dynamic_agent_client`, a persistent VM host ID, fresh state/nonce/PKCE, the exact loopback callback, and the documented scopes/resource. Exchange uses the callback's issued client ID. That registration is persisted even after failed exchange, so a restart does not lose fresh-sign-in recovery. The bridge verifies the ID token's signature, issuer, audience, expiry, and nonce before activating a connection.

One-time codes and rotating refresh grants are sent once per attempt. The controller atomically claims each exchange and refuses redirects. It prints status only and writes the result to owner-only VM files, never local token files. Expired transfer files are removed. Refresh is serialized, honors `earliest_refresh_at`, and atomically saves replacements before returning them. Run one bridge process per credential directory.

A valid identity without plan permission remains signed in with inference disabled. Terminal refresh errors clear unusable access/refresh tokens while retaining the validated profile and client registration for reconnection. Temporary errors retain credentials. These behaviors follow the [recovery guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

Safe status diagnostics are at `/auth/status`; detailed redacted diagnostics are in the private `last-oauth-error.json`. No authorization code, verifier, bearer token, or submitted client ID is logged there. If OpenAI rejects a grant, retain its request ID for diagnosis. Start a fresh authorization with the saved registration. Do not replay codes or change client identity. Disconnect the app through ChatGPT settings to revoke access.

## Assistant compatibility

The environment routes the real Assistant through this model configuration:

```ini
N8N_INSTANCE_AI_MODEL=openai/chatgpt-plan
N8N_INSTANCE_AI_MODEL_URL=http://chatgpt-bridge:3210/v1
N8N_INSTANCE_AI_MODEL_API_KEY=<private bridge key>
```

The key authenticates n8n to the private bridge. Only the OAuth bearer reaches `https://api.openai.com/v1/responses`. The explicit alias pins Responses throughout the central model factory, covering the Assistant, child agents, title generation, and observational memory. The self-managed resolver uses this environment endpoint and does not apply n8n's hosted-credit balance. The connection does not replace credentials used by OpenAI nodes inside generated workflows.

The SDK must receive `store: false` **before** converting history. Otherwise it emits stored item references, losing encrypted reasoning on follow-up calls even if the bridge later changes the body. The factory middleware preserves full history, enables reasoning for the alias, and requests encrypted reasoning content. Real SDK tests reproduced that failure before the patch and passed afterward.

The bridge streams upstream, collects completed SSE for non-streaming setup probes, converts system messages to developer messages, removes unsupported fields, and keeps local tools in the `n8n` namespace, including older tool calls no longer in the active set. n8n's deferred `search_tools` and `load_tool` are local function tools; they do not require OpenAI's hosted tool-search capability. Workflow compilation, sandbox operations, permissions, and approval handling execute in n8n. The overlay also bounds sandbox reference-file uploads and cache reads: stock n8n issued them concurrently and exceeded the sandbox service's 16-request limit during cold setup.

Images and inline files retain their content. The bridge accepts bodies up to 32 MiB, covering n8n's 16 MiB combined attachment allowance plus message overhead. Longer histories still need to fit this bound. Models must support the supplied modality. Files uploads, embeddings, audio, hosted code execution, and other API endpoints are outside this integration.

Provider failures preserve HTTP status, JSON body shape, error code/parameter, request ID, and retry delay. Streamed failures remain streamed. Non-streaming model checks retain errors received inside SSE, including plan-limit codes and retry delays. Successful streams retain the provider request ID. A disconnected n8n client cancels its upstream inference request. Subscription limits stop inference with no paid fallback. Model selection uses the signed-in catalog. See [plan inference requirements](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

## Verification

Run on the VM:

```sh
corepack pnpm install --ignore-workspace --frozen-lockfile
corepack pnpm test
corepack pnpm lint
corepack pnpm format:check
python3 test/local-controller-wire.py
sh test/run-assistant-smoke.sh
```

The 31 focused tests cover request adaptation, real JWT validation, state/PKCE, credential permissions, rotating refresh, recovery, exchange-file transfer, origins, provider errors, attachment sizes, and stream cancellation. The Python wire test verifies exact form encoding and PKCE against a single-use test endpoint, error preservation, and redirect refusal.

The Assistant smoke test uses the actual pinned n8n image, model factory, SDK, Assistant REST/SSE, workflow adapter, sandbox, and a disposable SQLite database. The real SDK also checks a plan-limit error received inside SSE during a non-streaming probe. It retains the status, code, request ID, and retry delay. It seeds a fake owner/workflow, follows local tools, replays encrypted reasoning, and checks a later conversation turn, then compiles a TypeScript workflow in the real sandbox and confirms its SQLite save. It also checks the native file helpers against the service request budget. It never calls OpenAI and never creates an owner in the deployed instance. The mock supplies deterministic model responses; it verifies integration contracts, not reasoning quality or plan admission.

Full monorepo checks and live paid-plan inference have not been run. A successful real OAuth exchange and Responses request remain necessary before relying on the integration.

## References

- [n8n Assistant setup](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant/)
- [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Plan models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
