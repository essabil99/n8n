// n8n's cold workspace setup must stay below the sandbox service's request limit.
const { createRequire } = require('node:module');
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const requireN8n = createRequire('/usr/local/lib/node_modules/n8n/package.json');
if (requireN8n('./package.json').version !== '2.42.6')
	throw new Error('Review the sandbox overlay for this n8n version.');
const directory = join(dirname(requireN8n.resolve('@n8n/instance-ai')), 'workspace');
const patches = [
	[
		'workspace-files.js',
		`await Promise.all(Array.from(files, async ([filePath, content]) => {
            await writeWorkspaceFile(workspace, filePath, content, options);
        }));`,
		`const n8nSandboxWriteModule = require('p-limit');
        const n8nSandboxWriteLimit = (n8nSandboxWriteModule.default ?? n8nSandboxWriteModule)(8);
        await Promise.all(Array.from(files, ([filePath, content]) => n8nSandboxWriteLimit(async () => {
            await writeWorkspaceFile(workspace, filePath, content, options);
        })));`,
	],
	[
		'prebaked-workspace-bundle.js',
		`const existenceChecks = await Promise.all(payloadPaths.map(async (path) => ({
            path,
            exists: (await (0, workspace_files_1.readWorkspaceFile)(options.workspace, path, {
                logger: options.logger,
                resourceLabel: options.resourceLabel,
            })) !== null,
        })));`,
		`const n8nSandboxReadModule = require('p-limit');
        const n8nSandboxReadLimit = (n8nSandboxReadModule.default ?? n8nSandboxReadModule)(8);
        const existenceChecks = await Promise.all(payloadPaths.map((path) => n8nSandboxReadLimit(async () => ({
            path,
            exists: (await (0, workspace_files_1.readWorkspaceFile)(options.workspace, path, {
                logger: options.logger,
                resourceLabel: options.resourceLabel,
            })) !== null,
        }))));`,
	],
];
for (const [name, before, after] of patches) {
	const target = join(directory, name);
	const source = readFileSync(target, 'utf8');
	if (
		source.split(before).length !== 2 ||
		source.includes('n8nSandboxWriteLimit') ||
		source.includes('n8nSandboxReadLimit')
	)
		throw new Error('Unexpected workspace file layout.');
	writeFileSync(target, source.replace(before, after));
}
console.log('Installed bounded sandbox workspace file writes and reads.');
