import { TokenStore } from './auth.mjs';
import { createServers } from './server.mjs';

const store = new TokenStore(process.env.CHATGPT_AUTH_DIR ?? './data');
await store.init();
const { infer, admin } = await createServers({
	store,
	apiKey: process.env.CHATGPT_BRIDGE_API_KEY,
	model: process.env.CHATGPT_PLAN_MODEL ?? 'gpt-6.1-sol',
	redirectUri: process.env.CHATGPT_REDIRECT_URI ?? 'http://127.0.0.1:1455/auth/callback',
});
await infer.listen({ port: 3210, host: '0.0.0.0' });
await admin.listen({ port: 1455, host: '0.0.0.0' });
console.log('ChatGPT plan bridge is ready. The local sign-in page uses port 1455.');
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, async () => {
		await Promise.all([infer.close(), admin.close()]);
		process.exit(0);
	});
}
