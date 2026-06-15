#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const isWatch = process.argv.includes('--watch');
const isServe = process.argv.includes('--serve');

// Dev-server URL (per workspace convention) — must be served via backloop.dev
// rather than bare localhost so the browser can hit remote HTTPS Pryv APIs
// without mixed-content / CORS pre-flight failures.
const SERVE_SUBDOMAIN = process.env.BACKLOOP_SUBDOMAIN || 'backup';
const SERVE_PORT = parseInt(process.env.BACKLOOP_PORT || '4443', 10);

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
  // browser-side backup. Replaces fs/path/https with an empty object module;
  // the webapp's hot path uses fetch + writer + fflate. `async` is a pure-JS
  // npm package — bundled, not stubbed (mapLimit is called by the
  // attachments / hf-data / webhooks drainers).
  alias: {
    fs: nodeStub,
    path: nodeStub,
    https: nodeStub,
    http: nodeStub,
    crypto: nodeStub,
    stream: nodeStub
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

function spawnBackloopStatic (distDir, port) {
  // The `backloop.dev` package's exports field restricts subpath access, so
  // we go through npm's bin shim rather than require.resolve. `npm exec`
  // works for both local + global installs.
  const cliPath = path.resolve(__dirname, 'node_modules/.bin/backloop.dev');
  const child = spawn(cliPath, [distDir, String(port)], {
    stdio: 'inherit',
    shell: false
  });
  child.on('exit', (code) => {
    if (code != null && code !== 0) {
      console.error('backloop.dev exited with code ' + code);
      process.exit(code);
    }
  });
  return child;
}

(async () => {
  if (isServe) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStatics();
    const distDir = path.resolve(__dirname, 'dist');
    spawnBackloopStatic(distDir, SERVE_PORT);
    console.log('Webapp dev URL: https://' + SERVE_SUBDOMAIN + '.backloop.dev:' + SERVE_PORT + '/');
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
