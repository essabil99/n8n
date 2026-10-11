// Build-time overlay for the pinned n8n image; fail if the upstream layout changes.
const { createRequire } = require('node:module');
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const requireN8n = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const version = requireN8n('./package.json').version;
if (version !== '2.42.6')
	throw new Error('The runtime overlay must be reviewed for this n8n version.');
const target = join(dirname(requireN8n.resolve('@n8n/agents')), 'runtime/model/model-factory.js');
const source = readFileSync(target, 'utf8');
const anchor = 'const { baseURL } = providerCreds;';
if (source.split(anchor).length !== 2 || source.includes('n8nChatgptStateless'))
	throw new Error('Unexpected model factory layout.');
const helper = readFileSync(join(__dirname, 'stateless-responses.cjs'), 'utf8')
	.replace('module.exports = function statelessResponses', 'function n8nChatgptStateless')
	.replace(/;\s*$/, '');
const branch = `
            if (model === 'chatgpt-plan' && baseURL) {
                const { wrapLanguageModel } = require('ai');
                return n8nChatgptStateless(createOpenAI({ ...providerCreds, fetch })(model), wrapLanguageModel);
            }`;
writeFileSync(target, source.replace(anchor, anchor + branch) + '\n' + helper + '\n');
console.log('Installed stateless Responses for the explicit chatgpt-plan model alias.');
