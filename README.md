# Dwi Nov

Dwi Nov helps you draft and review prompts in desktop Visual Studio Code. Use Scratch for a one-off prompt or save a project prompt and return to it through Recents. Grammar checks and model inference run locally.

## Install on Windows x64

Download the Windows x64 VSIX from [Releases](https://github.com/vinodsalina-cpu/dwi-nov-public-release/releases). In VS Code 1.109 or later, run **Extensions: Install from VSIX…** in the Command Palette. Select the downloaded file, reload the window if prompted, then open **Dwi Nov** in the Activity Bar.

## Try the review flow

Open **Scratch**, enter a draft, and choose **Review**. Review the suggested edits and confirm the wording you want to use. To keep a draft between sessions, initialize a project and create a project prompt. See the [demo presentation](demo/) for a walkthrough.

## Build from source

Use Node.js 22.23.5 with Corepack enabled and VS Code installed. Run the commands in the repository root on the platform you want to package. Corepack reads the exact pnpm version from the project manifest.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm audit
pnpm run package
```

The package command produces a platform-specific VSIX in the repository root. A Windows x64 build produces `dwi-nov-win32-x64.vsix`. The clone includes the model files; packaging verifies their SHA-256 digests before bundling the native runtime.
