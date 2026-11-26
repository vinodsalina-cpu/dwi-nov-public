const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { createVSIX } = require('@vscode/vsce');

const root = path.join(__dirname, '..');
const options = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22',
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  metafile: true,
};

// The host imports Harper on first review. Keeping this module as ESM also
// preserves the slim WASM URL relative to import.meta.url on each platform.
const lazyHarper = {
  name: 'lazy-harper',
  setup(builder) {
    builder.onResolve({ filter: /^harper\.js(?:\/slimBinary)?$/ }, () => ({
      path: './harper.mjs', external: true,
    }));
  },
};

function writeNotices(results) {
  const packages = new Set();
  for (const { metafile } of results) {
    for (const input of Object.keys(metafile.inputs)) {
      const match = /^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (match) packages.add(match[1]);
    }
  }
  const notices = [];
  for (const dir of [...packages].sort()) {
    const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const files = fs.readdirSync(dir).filter(file => /^(?:licen[sc]e|notice|copying)(?:[.\-].*)?$/i.test(file));
    const documents = name === 'harper.js'
      ? ['vendor/harper-LICENSE', 'vendor/harper-ranker-NOTICE']
      : files.sort().map(file => path.join(dir, file));
    if (!documents.length) throw new Error(`Missing third-party license for ${name}@${version}`);
    const text = documents.map(file => fs.readFileSync(file, 'utf8').trim()).join('\n\n');
    notices.push(`${name}@${version}\n\n${text}`);
  }
  notices.push('gibb@1.0.3\n\n' + fs.readFileSync('vendor/gibb-LICENSE', 'utf8').trim());
  const ortLicense = fs.readFileSync('vendor/onnxruntime-LICENSE', 'utf8').trim();
  const ortNotices = fs.readFileSync('vendor/onnxruntime-NOTICES', 'utf8').trim();
  const ortVersion = require('../package.json').devDependencies['onnxruntime-node'];
  notices.push(`ONNX Runtime ${ortVersion}\n\n${ortLicense}\n\n${ortNotices}`);
  fs.writeFileSync('out/THIRD-PARTY-NOTICES.txt', notices.join('\n\n--------------------\n\n') + '\n');
}

async function main() {
  const extension = await build({
    ...options,
    entryPoints: ['src/extension.ts', 'src/core/modernbert/worker.ts'],
    outdir: 'out', outbase: 'src', format: 'cjs', external: ['vscode'], plugins: [lazyHarper],
  });
  const harper = await build({
    ...options,
    stdin: {
      contents: "export { LocalLinter, Dialect, SuggestionKind } from 'harper.js';\nexport { slimBinary } from 'harper.js/slimBinary';",
      resolveDir: root,
    },
    outfile: 'out/harper.mjs', format: 'esm',
  });
  const wasm = 'harper_wasm_slim_bg.wasm';
  fs.copyFileSync(path.join('node_modules', 'harper.js', 'dist', wasm), path.join('out', wasm));
  writeNotices([extension, harper]);

  const target = process.platform + '-' + process.arch;
  await createVSIX({
    target, dependencies: false,
    packagePath: 'dwi-nov-' + target + '.vsix',
    allowMissingRepository: true, rewriteRelativeLinks: false,
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
