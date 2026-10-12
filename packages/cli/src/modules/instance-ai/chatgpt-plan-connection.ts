import type { InstanceAiConfig } from '@n8n/config';
import { z } from 'zod';

const statusSchema = z.object({
 sign_in_pending: z.boolean().optional(),
 authenticated: z.boolean(),
 plan_authorized: z.boolean(),
 reauthorization_required: z.boolean(),
 model: z.string().max(128),
});
const modelSchema = z.object({ slug: z.string().min(1).max(128), display_name: z.string().optional() });
const selectedModelSchema = z.object({ model: z.string().trim().min(1).max(128) }).strict();
const startSchema = z.object({ url: z.string().url() });

export function isChatgptPlanConfigured(config: InstanceAiConfig): boolean {
 return config.model === 'openai/chatgpt-plan' && Boolean(config.modelUrl && config.modelApiKey);
}

async function request(config: InstanceAiConfig, action: string, body?: unknown): Promise<unknown> {
 if (!isChatgptPlanConfigured(config)) throw new Error('ChatGPT subscription is not configured on this instance.');
 const url = new URL(config.modelUrl);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
  throw new Error('The ChatGPT bridge address is invalid.');
 url.pathname = url.pathname.replace(/\/$/, '') + '/connection/' + action;
 try {
  const response = await fetch(url, {
   method: body === undefined ? 'GET' : 'POST',
   headers: { Authorization: 'Bearer ' + config.modelApiKey, 'Content-Type': 'application/json' },
   ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   redirect: 'error',
   signal: AbortSignal.timeout(action === 'status' ? 5_000 : 30_000),
  });
  if (!response.ok) throw new Error('Connection request rejected.');
  return await response.json();
 } catch {
  throw new Error('ChatGPT connection could not be checked. Check the bridge and try again.');
 }
}

export async function getChatgptPlanStatus(config: InstanceAiConfig) {
 return statusSchema.parse(await request(config, 'status'));
}
export async function startChatgptPlanSignIn(config: InstanceAiConfig) {
 const result = startSchema.parse(await request(config, 'start', {}));
 const url = new URL(result.url);
 if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize')
  throw new Error('ChatGPT returned an invalid sign-in address.');
 return result;
}
export async function getChatgptPlanModels(config: InstanceAiConfig) {
 return z.object({ models: z.array(modelSchema) }).parse(await request(config, 'models'));
}
export async function selectChatgptPlanModel(config: InstanceAiConfig, input: unknown) {
 const body = selectedModelSchema.parse(input);
 return selectedModelSchema.parse(await request(config, 'model', body));
}
