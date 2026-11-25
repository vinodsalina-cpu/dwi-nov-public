# Dwi Nov

Dwi Nov is a VS Code extension for drafting, reviewing and organizing prompts. The bundled model runs locally.

## Build and install on Windows x64

Install Git, Node.js 22 and VS Code 1.109 or later. Open PowerShell in the cloned repository and run:

```powershell
npm.cmd ci
npm.cmd run package
code --install-extension .\dwi-nov.vsix
```

Reload VS Code, open a workspace and select **Dwi Nov** in the Activity Bar.
