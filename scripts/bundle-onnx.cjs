// Stage only the v13 graphs and CPU packages required by this VSIX target.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out');
const destination = path.join(output, 'modernbert');
const graphs = path.join(root, 'model');
const assets = {
  'encoder.onnx': 'c2e60f521139b83b330ce8a909c9a75f5b44b3031cf9ae2f5418fd332b006f95',
  'encoder-weights-00.bin': 'c5c5b3a18727c4f0e06b985d2d5d29a81f1b05a4a1f850e6c5ed9544890b963e',
  'encoder-weights-01.bin': '5e458523ad323c76a329982a85b2e5bc8e0319aa68d458bc88b014d5ce96cb40',
  'encoder-weights-02.bin': 'd8e43af9e8df79d60c144d83a4f9270e27b3d4d44b8a133518800b2a139d95c3',
  'encoder-weights-03.bin': 'd07dd329a73e14882e046931b91b288c41842f82577f94ca0a5f9ae407d764e8',
  'encoder-weights-04.bin': '164c59cf89402c697ac62ec03eaf07b40ba069c8039fafccd6feac1c3b3ea401',
  'encoder-weights-05.bin': '2c33d82e216d52114aafbe8a26959a13edbcf364d996fb4d946759de9a746db1',
  'encoder-weights-06.bin': '9ab48e2b0c29445e1dd9c9ebe1c531818d245ccc19148b3bba820cac342fa844',
  'encoder-weights-07.bin': 'a2389f8d7a3513fee53deaa4214e9cc8d6b768d53d8da93700b2af11dfb48ba9',
  'encoder-weights-08.bin': '5acf2f17500fa7f554032ab1465fc1553eb386b77f1abf8dd69dba9bb23ca0f3',
  'plan.onnx': '0ed1ea8e1277470ffbfc3f6d653291039dd8e1df17a5fe76da5ff44605f6f839',
  'spans.onnx': '33700ad9092a3921ed44e211ef7acdb60f7f82d6e4e9865c636b19a4cfe3cd6c',
  'decoder.json': 'ddb525eaf58072462399946270204af85f4b9ee2e6e85d4acb689ee895236bb7',
  'tokenizer.json': '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30',
};

async function stageAsset(source, target, expected) {
  if (path.basename(source) === 'encoder-weights-00.bin') {
    for (const index of [0, 1]) {
      await pipeline(fs.createReadStream(source + '.' + index), fs.createWriteStream(target, { flags: index === 0 ? 'w' : 'a' }));
    }
  } else if (['decoder.json', 'tokenizer.json'].includes(path.basename(source))) {
    // Latin-1 maps each byte one-to-one so only CRLF pairs can change.
    const bytes = fs.readFileSync(source, 'latin1');
    fs.writeFileSync(target, bytes.replace(/\r\n/g, '\n'), 'latin1');
  } else {
    fs.copyFileSync(source, target);
  }
  const digest = createHash('sha256');
  for await (const bytes of fs.createReadStream(target)) digest.update(bytes);
  if (digest.digest('hex') !== expected) throw new Error('Unexpected artifact digest for ' + path.basename(source));
}

function stagePackage(rootName, files, modules) {
  const source = path.join(root, 'node_modules', rootName);
  const target = path.join(modules, rootName);
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['package.json', ...files]) {
    fs.cpSync(path.join(source, file), path.join(target, file), { recursive: true });
  }
}

async function main() {
  const { platform, arch } = process;
  const osTag = {
    darwin: `darwin-${arch}`, linux: `linux-${arch}-gnu`, win32: `win32-${arch}-msvc`,
  }[platform];
  const library = {
    darwin: 'libonnxruntime.1.24.3.dylib', linux: 'libonnxruntime.so.1', win32: 'onnxruntime.dll',
  }[platform];
  if (!osTag || !library || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported ONNX build target.');
  const binding = path.join('bin', 'napi-v6', platform, arch);
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(output, 'modernbert-staging-'));
  try {
    for (const [name, digest] of Object.entries(assets)) {
      const source = path.join(graphs, name);
      await stageAsset(source, path.join(temporary, name), digest);
    }
    const modules = path.join(temporary, 'node_modules');
    // Keep the upstream loader next to the native binary tree it resolves at run time.
    stagePackage('onnxruntime-node', ['dist/index.js', 'dist/backend.js', 'dist/binding.js', 'dist/version.js',
      path.join(binding, 'onnxruntime_binding.node'), path.join(binding, library)], modules);
    stagePackage('onnxruntime-common', ['dist/cjs/package.json'], modules);
    await esbuild.build({
      entryPoints: [require.resolve('onnxruntime-common')],
      outfile: path.join(modules, 'onnxruntime-common', 'dist', 'cjs', 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      banner: { js: '/*! ONNX Runtime. Copyright (c) Microsoft Corporation. Licensed under the MIT License. */' },
    });
    stagePackage('tokenizers', ['index.js', 'LICENSE', `tokenizers.${osTag}.node`], modules);
    // VS Code's Node loader resolves these packages relative to the bundle.
    const load = require('node:module').createRequire(path.join(temporary, 'decoder.json'));
    load('onnxruntime-node');
    load('tokenizers');
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporary, destination);
    console.log(`Packaged ModernBERT v13 ONNX for ${platform}/${arch}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
