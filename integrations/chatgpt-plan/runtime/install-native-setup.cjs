// Apply the native setup feature to the reviewed n8n image.
const { createRequire } = require('node:module');
const { readFileSync, writeFileSync, copyFileSync, cpSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const requireN8n = createRequire('/usr/local/lib/node_modules/n8n/package.json');
if (requireN8n('./package.json').version !== '2.42.6')
	throw new Error('Review native setup for this n8n version.');
const root = '/usr/local/lib/node_modules/n8n/dist/modules/instance-ai';
function edit(file, old, replacement) {
	const source = readFileSync(file, 'utf8');
	if (source.split(old).length !== 2) throw new Error('Unexpected native setup anchor: ' + file);
	writeFileSync(file, source.replace(old, replacement));
}
const helperName = './chatgpt-plan-connection';
copyFileSync(
	join(__dirname, 'native-chatgpt-connection.cjs'),
	join(root, 'chatgpt-plan-connection.js'),
);
const service = join(root, 'instance-ai-settings.service.js');
edit(
	service,
	'    buildAdminSettingsResponse(credentialSelection) {',
	'    async buildAdminSettingsResponse(credentialSelection) {',
);
let source = readFileSync(service, 'utf8');
const start = source.indexOf('    async buildAdminSettingsResponse(credentialSelection) {');
const end = source.indexOf('    async ', start + 10);
const region = source.slice(start, end);
const anchor = '        return {\n            enabled: this.enabled,';
if (region.split(anchor).length !== 2) throw new Error('Unexpected native settings response.');
const replacement = `        return {
            chatgptPlan: directEnvironmentConfig && require('${helperName}').isChatgptPlanConfigured(c)
                ? await this.getChatgptPlanStatus().catch(() => ({
                    authenticated: false, plan_authorized: false, reauthorization_required: false, model: '',
                }))
                : undefined,
            enabled: this.enabled,`;
writeFileSync(
	service,
	source.slice(0, start) + region.replace(anchor, replacement) + source.slice(end),
);
edit(
	service,
	'const response = this.buildAdminSettingsResponse({',
	'const response = await this.buildAdminSettingsResponse({',
);
edit(
	service,
	'    getConfiguredModelId() {',
	`
    getChatgptPlanStatus() { return require('${helperName}').getChatgptPlanStatus(this.config); }
    startChatgptPlanSignIn() { return require('${helperName}').startChatgptPlanSignIn(this.config); }
    getChatgptPlanModels() { return require('${helperName}').getChatgptPlanModels(this.config); }
    selectChatgptPlanModel(input) { return require('${helperName}').selectChatgptPlanModel(this.config, input); }
    getConfiguredModelId() {`,
);
const controller = join(root, 'instance-ai.controller.js');
edit(
	controller,
	'    async getModelCatalog(_req) {',
	`
    async getChatgptPlanStatus(_req) { return await this.settingsService.getChatgptPlanStatus(); }
    async startChatgptPlanSignIn(_req) { return await this.settingsService.startChatgptPlanSignIn(); }
    async getChatgptPlanModels(_req) { return await this.settingsService.getChatgptPlanModels(); }
    async selectChatgptPlanModel(req) { return await this.settingsService.selectChatgptPlanModel(req.body); }
    async getModelCatalog(_req) {`,
);
const routeAnchor = "__decorate([\n    (0, decorators_1.Get)('/settings/models'),";
const routes = [
	['Get', 'status', 'getChatgptPlanStatus'],
	['Post', 'start', 'startChatgptPlanSignIn'],
	['Get', 'models', 'getChatgptPlanModels'],
	['Post', 'model', 'selectChatgptPlanModel'],
]
	.map(
		([verb, path, name]) => `__decorate([
    (0, decorators_1.${verb})('/settings/chatgpt/${path}'),
    (0, decorators_1.GlobalScope)('instanceAi:manage'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], InstanceAiController.prototype, "${name}", null);
`,
	)
	.join('');
edit(controller, routeAnchor, routes + routeAnchor);
const schema = join(dirname(requireN8n.resolve('@n8n/api-types')), 'schemas/instance-ai.schema.js');
edit(
	schema,
	'const modelSource = settings.modelEnvConfigured',
	`const subscriptionReady = !settings.chatgptPlan ||
        (settings.chatgptPlan.authenticated && settings.chatgptPlan.plan_authorized && Boolean(settings.chatgptPlan.model));
    const modelSource = !subscriptionReady ? 'none' : settings.modelEnvConfigured`,
);
const uiRoot = dirname(requireN8n.resolve('n8n-editor-ui/package.json'));
const ui = join(__dirname, 'editor-ui-dist');
if (!existsSync(join(ui, 'index.html'))) throw new Error('Build the pinned native frontend first.');
cpSync(ui, join(uiRoot, 'dist'), { recursive: true });
console.log('Installed owner/admin ChatGPT setup routes and the pinned native frontend.');
