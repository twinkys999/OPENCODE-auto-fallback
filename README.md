# Auto-Fallback 🤖

**Auto-Fallback** is an OpenCode plugin that watches provider failures and, when the active model runs out of tokens or quota, switches the session to the next model in the fallback chain and lets OpenCode retry the same step. Nothing to restart and nothing to retype.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![OpenCode](https://img.shields.io/badge/OpenCode-Plugin-7C3AED?logo=opencode&logoColor=white)

## ✨ Features

- **Automatic fallback** — on a quota failure (`402`, `429`, or quota-like messages) the session moves to the next model of the chain and OpenCode retries the same step (`retry: true`, delay capped by `maxRetryDelayMs`).
- **Conservative failure handling** — context overflow, auth errors, unknown models and server errors never trigger a switch; only real quota exhaustion does.
- **Cooldown** — a model that just reported exhaustion is skipped for `cooldownMinutes` before the chain moves on.
- **Chain management** — toggle the fallback on/off, add or remove models, reset to the defaults, or clear the chain.
- **Free-first, Russia-safe list** — the default chain ships free OpenCode Zen models; only providers marked Russia-safe (`opencode`) are offered in the picker.
- **Hot settings** — `~/.config/opencode/auto-fallback.json`, re-read before every decision, hand-editable, broken JSON falls back to defaults.
- **Two frontends** — terminal UI and OpenCode Desktop GUI, sharing one RPC contract.

## 📋 Prerequisites

- OpenCode with the plugin API used here (`@opencode/plugin` 2.2.6): server hooks, RPC and model listing.
- Node.js, TypeScript and Vite (with `vite-plugin-solid` and SolidJS) to build the desktop GUI part.

## 🚀 Installation & Usage

```bash
git clone https://github.com/twinkys999/OPENCODE-auto-fallback.git
```

**Linux / macOS**

```bash
mkdir -p ~/.config/opencode/plugins
cp -r opencode-auto-fallback/. ~/.config/opencode/plugins/auto-fallback/
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/twinkys999/OPENCODE-auto-fallback.git
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\plugins\auto-fallback"
Copy-Item -Recurse -Force "opencode-auto-fallback\*" "$env:USERPROFILE\.config\opencode\plugins\auto-fallback\"
```

Build the GUI part and enable the plugin:

```bash
cd ~/.config/opencode/plugins/auto-fallback
npm install
npx tsc --noEmit
npx vite build
```

**Usage**

```bash
F3                  # toggle the automatic fallback
/aft                # quick toggle from the prompt
/fallback           # settings menu
/af                 # alias for the settings menu
```

In OpenCode Desktop the same controls work: `/af`, `/aft`, `F3`, and the command palette (group «Авто-фолбэк»).

### 📸 Demo

<!-- Paste the /fallback menu screenshot here, e.g. uncomment the line below and drop the PNG into the repo -->
<!-- ![Auto-Fallback menu](docs/screenshot.png) -->

## ⚙️ Configuration

Settings live in `~/.config/opencode/auto-fallback.json` and are re-read before every decision:

```jsonc
{
  "enabled": true,
  "chain": [
    "opencode/glm-5.3-flash-free",
    "opencode/minimax-m3.1-flash-free"
  ],
  "cooldownMinutes": 30,
  "maxRetryDelayMs": 2000
}
```

- `enabled` — master switch (same as `F3`).
- `chain` — ordered fallback list as `provider/model`; first usable model wins.
- `cooldownMinutes` — how long a failed model is skipped.
- `maxRetryDelayMs` — upper bound before the retry.

## 📁 Project Structure

```
auto-fallback/
├── .gitignore
├── LICENSE
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── index.ts
│   ├── rpc.ts
│   ├── settings.ts
│   ├── shared.ts
│   ├── tui.ts
│   └── gui.tsx
└── dist/
    └── gui-experimental.cjs
```

## 🔧 Development

```bash
npm install
npx tsc --noEmit      # type check
npx vite build        # build the desktop GUI part
```
