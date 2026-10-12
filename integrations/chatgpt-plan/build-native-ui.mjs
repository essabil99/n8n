// Build the native frontend from the exact runtime tag. Keep the build outside this checkout.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	copyFileSync,
	cpSync,
	openSync,
	closeSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const integration = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(integration, '../..');
const workspace = dirname(checkout);
const build = join(workspace, 'native-ui-build');
const logs = join(workspace, 'private');
const pinned = '34ab9c7bf3d0c6d2ec3422e12e0b970aea5717c7';
const sourceBase = '3301b2cc0f59d28753b0219883f2c9dbc522dc03';
const marker = join(build, '.chatgpt-plan-native-build');
mkdirSync(logs, { recursive: true, mode: 0o700 });
const logPath = join(logs, 'native-ui-rebuild.log');
const log = openSync(logPath, 'w', 0o600);
function run(command, args, cwd = build, extraEnv = {}, input) {
	return execFileSync(command, args, {
		cwd,
		input,
		env: {
			...process.env,
			TURBO_TELEMETRY_DISABLED: '1',
			NODE_OPTIONS: '--max-old-space-size=2048',
			...extraEnv,
		},
		stdio: input === undefined ? ['ignore', log, log] : ['pipe', log, log],
	});
}
const tracked = [
	'packages/@n8n/api-types/src/schemas/instance-ai.schema.ts',
	'packages/frontend/editor-ui/src/features/ai/instanceAi/instanceAi.settings.api.ts',
	'packages/frontend/editor-ui/src/features/ai/instanceAi/onboarding/InstanceAiOnboardingWizard.vue',
	'packages/frontend/editor-ui/src/features/ai/instanceAi/onboarding/InstanceAiOnboardingView.vue',
	'packages/frontend/editor-ui/src/features/ai/instanceAi/views/SettingsInstanceAiView.vue',
];
const newFiles = [
	'packages/frontend/editor-ui/src/features/ai/instanceAi/components/settings/ChatgptPlanConnection.vue',
	'packages/frontend/editor-ui/src/features/ai/instanceAi/components/settings/__tests__/ChatgptPlanConnection.test.ts',
];
try {
	if (!existsSync(build)) {
		run(
			'git',
			[
				'fetch',
				'--depth=1',
				'https://github.com/n8n-io/n8n.git',
				'refs/tags/n8n@2.42.6:refs/tags/n8n@2.42.6',
			],
			checkout,
		);
		run('git', ['worktree', 'add', '--detach', build, pinned], checkout);
		writeFileSync(marker, pinned, { mode: 0o600 });
	}
	if (!existsSync(marker) || readFileSync(marker, 'utf8') !== pinned)
		throw new Error('Use a build worktree created by this script.');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: build, encoding: 'utf8' }).trim();
	if (head !== pinned) throw new Error('The native frontend build has an unexpected base.');
	const modified = execFileSync('git', ['diff', '--name-only'], { cwd: build, encoding: 'utf8' })
		.trim()
		.split('\n')
		.filter(Boolean);
	const locale = 'packages/frontend/@n8n/i18n/src/locales/en.json';
	if (modified.some((path) => !tracked.includes(path) && path !== locale))
		throw new Error('The reserved frontend build contains unrelated source changes.');
	run('git', ['restore', '--', ...tracked, locale]);
	const patch = execFileSync('git', ['diff', '--binary', sourceBase, '--', ...tracked], {
		cwd: checkout,
	});
	run('git', ['apply', '--'], build, {}, patch);
	for (const file of newFiles) {
		mkdirSync(dirname(join(build, file)), { recursive: true });
		copyFileSync(join(checkout, file), join(build, file));
	}
	const sourceLocale = JSON.parse(readFileSync(join(checkout, locale), 'utf8'));
	const pinnedLocale = JSON.parse(readFileSync(join(build, locale), 'utf8'));
	for (const [key, value] of Object.entries(sourceLocale))
		if (key.startsWith('instanceAi.chatgpt.')) pinnedLocale[key] = value;
	writeFileSync(join(build, locale), JSON.stringify(pinnedLocale, null, '	') + '\n');
	run('pnpm', ['--filter', 'n8n-editor-ui...', 'install', '--frozen-lockfile', '--ignore-scripts']);
	run('pnpm', [
		'exec',
		'turbo',
		'run',
		'build:unchecked',
		'--filter=n8n-editor-ui^...',
		'--concurrency=2',
	]);
	run('pnpm', ['exec', 'vite', 'build'], join(build, 'packages/frontend/editor-ui'), {
		NODE_OPTIONS: '--max-old-space-size=3072',
		VUE_APP_PUBLIC_PATH: '/{{BASE_PATH}}/',
	});
	cpSync(join(build, 'packages/frontend/editor-ui/dist'), join(integration, 'editor-ui-dist'), {
		recursive: true,
	});
	const requireBuild = createRequire(join(build, 'package.json'));
	const ts = requireBuild('typescript');
	const helper = readFileSync(
		join(checkout, 'packages/cli/src/modules/instance-ai/chatgpt-plan-connection.ts'),
		'utf8',
	);
	const compiled = ts.transpileModule(helper, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
		reportDiagnostics: true,
	});
	if (compiled.diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error))
		throw new Error('Native connection helper could not compile.');
	writeFileSync(join(integration, 'runtime/native-chatgpt-connection.cjs'), compiled.outputText);
	console.log('Native build ready. Build Dockerfile.n8n. Log: ' + logPath);
} finally {
	closeSync(log);
}
