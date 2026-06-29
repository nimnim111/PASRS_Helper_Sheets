import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

import path from 'node:path';

console.log(path.resolve(__dirname, 'src'));

export default defineConfig({
	plugins: [pluginReact()],

	output: {
		filenameHash: false,
		distPath: {
			js: 'dist',
			css: 'dist',
			root: 'output',
		},
	},
	source: {
		define: {
			VERSION: JSON.stringify(require('./manifest.base.json').version),
		},
		entry: {
			extension: './src/extension/index.ts',
			background: './src/background/index.ts',
			showdown: './src/lib/showdown/showdown.ts',
			react: './src/index.tsx',
		},
	},
	tools: {
		htmlPlugin: false,
	},
	environment: {
		extension: {
			source: {
				preEntryHandlers: [
					{
						handler: 'DefinePlugin',
						options: {
							'process.env.BROWSER': JSON.stringify('chrome'),
						},
					},
				],
			},
		},
	},
});
