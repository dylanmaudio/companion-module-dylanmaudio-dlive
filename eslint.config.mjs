import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const base = await generateEslintConfig({
	enableTypescript: true,
	ignores: ['vitest.config.ts', 'fixtures/**', 'dist/**', 'pkg/**'],
})

export default [
	...base,
	{
		files: ['src/**/*.test.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]
