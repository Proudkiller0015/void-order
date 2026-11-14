import js from '@eslint/js';
import globals from 'globals';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import prettier from 'eslint-config-prettier';

export default [
	js.configs.recommended,
	prettier,
	{
		files: ['void.js', 'void.user.js'],
		languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } },
		plugins: { 'no-unsanitized': noUnsanitized },
		rules: { 'no-unsanitized/method': 'error', 'no-unsanitized/property': 'error', 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
	},
	{
		files: ['server/src/**/*.js'],
		languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.worker, WebSocketPair: 'readonly', WebSocketRequestResponsePair: 'readonly' } },
		rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
	},
	{
		files: ['test.js', 'server/test-server.js'],
		languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
		// The game's globals, used inside page.evaluate.
		rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }], 'no-undef': 'off' },
	},
];
