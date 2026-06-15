// Empty stub for Node built-ins (`fs`, `path`, `https`, …). lib-js + the
// Node-only branches of @pryv/account-backup require these at parse time
// but only call them when running under Node. The webapp never reaches
// those call sites; the stub satisfies esbuild's static-bundle resolver
// without pulling Node code into the browser output.
module.exports = {};
