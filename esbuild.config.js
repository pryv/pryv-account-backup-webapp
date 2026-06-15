#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');
const isServe = process.argv.includes('--serve');

const nodeStub = path.resolve(__dirname, 'src/lib/node-stub.js');

const buildOptions = {
  entryPoints: [path.resolve(__dirname, 'src/app.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: path.resolve(__dirname, 'dist/app.js'),
  sourcemap: true,
  minify: !isWatch && !isServe,
  loader: { '.css': 'text' },
  // Stub Node built-ins that the Node-only branches of `pryv` (lib-js) and
  // `@pryv/account-backup` require at parse time but never call from a
  // browser-side backup. Replaces fs/path/https/JSONStream/async with an
  // empty object module; the webapp's hot path uses fetch + writer + fflate.
  alias: {
    fs: nodeStub,
    path: nodeStub,
    https: nodeStub,
    http: nodeStub,
    crypto: nodeStub,
    stream: nodeStub,
    JSONStream: nodeStub,
    async: nodeStub
  },
  define: {
    'process.env.NODE_ENV': isWatch || isServe ? '"development"' : '"production"'
  }
};

async function copyStatics () {
  const distDir = path.resolve(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  for (const file of ['index.html', 'style.css']) {
    fs.copyFileSync(
      path.resolve(__dirname, 'src', file),
      path.resolve(distDir, file)
    );
  }
}

(async () => {
  if (isServe) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStatics();
    const { host, port } = await ctx.serve({
      servedir: path.resolve(__dirname, 'dist'),
      host: '127.0.0.1',
      port: 8080
    });
    console.log('Webapp serving on http://' + host + ':' + port);
  } else if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStatics();
    console.log('Webapp watching for changes; built dist/');
  } else {
    await esbuild.build(buildOptions);
    await copyStatics();
    console.log('Webapp built to dist/');
  }
})().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
