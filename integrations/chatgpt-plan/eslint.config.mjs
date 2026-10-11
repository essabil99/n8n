import js from '@eslint/js';
export default [
	js.configs.recommended,
	{
		files: ['**/*.{js,mjs,cjs}'],
		languageOptions: {
			globals: Object.fromEntries(
				[
					'process',
					'console',
					'Buffer',
					'URL',
					'URLSearchParams',
					'fetch',
					'Headers',
					'Response',
					'AbortSignal',
					'AbortController',
					'TextDecoder',
					'setTimeout',
					'clearTimeout',
					'structuredClone',
					'document',
					'window',
				].map((name) => [name, 'readonly']),
			),
		},
	},
	{ ignores: ['node_modules/**', 'data/**'] },
];
