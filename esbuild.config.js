const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// Extension bundle (Node.js)
const extensionConfig = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

// Webview bundle (Browser)
const webviewConfig = {
  entryPoints: ['./src/webview/editor.ts'],
  bundle: true,
  outfile: './dist/webview/editor.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
};

async function build() {
  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log('Build complete');
  }
}

build().catch(() => process.exit(1));
