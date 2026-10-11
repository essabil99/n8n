// Exercise the actual patched n8n file helpers against a service-sized request budget.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const root = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const directory = join(dirname(root.resolve('@n8n/instance-ai')), 'workspace');
const { writeWorkspaceFileMap } = require(join(directory, 'workspace-files.js'));
const { loadPrebakedWorkspaceBundle } = require(join(directory, 'prebaked-workspace-bundle.js'));
const logger = { debug() {}, warn() {}, error() {}, info() {} };
const files = new Map(
	Array.from({ length: 100 }, (_, i) => ['/workspace/file-' + i, 'fixture-' + i]),
);
let active = 0;
let peak = 0;
const written = new Set();
async function budget(action) {
	active++;
	peak = Math.max(peak, active);
	try {
		assert.ok(active <= 16, 'Exceeded the sandbox service request budget');
		await new Promise((resolve) => setTimeout(resolve, 2));
		return action();
	} finally {
		active--;
	}
}
async function main() {
	const workspace = {
		filesystem: {
			writeFile: async (path, content) =>
				budget(() => {
					assert.equal(content, files.get(path));
					written.add(path);
				}),
			readFile: async (path) =>
				budget(() =>
					path === '/workspace/manifest'
						? JSON.stringify({ schemaVersion: 1, hash: 'fixture-hash' })
						: files.get(path),
				),
		},
	};
	await writeWorkspaceFileMap(workspace, files, { logger });
	assert.equal(written.size, files.size);
	const bundle = { files };
	const reused = await loadPrebakedWorkspaceBundle({
		workspace,
		manifestPath: '/workspace/manifest',
		expectedHash: 'fixture-hash',
		hashField: 'hash',
		schemaVersion: 1,
		resourceLabel: 'Fixture',
		logger,
		invalidManifestLogMessage: 'invalid',
		staleManifestLogMessage: 'stale',
		staleManifestLogKeys: { expected: 'expected', actual: 'actual' },
		successLogMessage: 'reused',
		successLogContext: () => ({}),
		buildBundle: () => bundle,
	});
	assert.equal(reused, bundle);
	assert.equal(active, 0);
	console.log('Actual sandbox bundle writes + cache reads: passed; peak requests=' + peak);
}
main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
