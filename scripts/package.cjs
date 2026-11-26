const { createVSIX } = require('@vscode/vsce');

const target = process.platform + '-' + process.arch;
createVSIX({
  target,
  packagePath: 'dwi-nov-' + target + '.vsix',
  allowMissingRepository: true,
  rewriteRelativeLinks: false,
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
