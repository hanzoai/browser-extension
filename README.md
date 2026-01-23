# Hanzo AI Browser Extension

AI-powered browser extension for Chrome, Firefox, Edge, and Safari.

[![Chrome](https://img.shields.io/badge/Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![Firefox](https://img.shields.io/badge/Firefox-FF7139?style=for-the-badge&logo=firefox&logoColor=white)](https://addons.mozilla.org)
[![Edge](https://img.shields.io/badge/Edge-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons)
[![Safari](https://img.shields.io/badge/Safari-000000?style=for-the-badge&logo=safari&logoColor=white)](https://apps.apple.com)

## Features

- **AI Chat Sidebar**: Chat with Claude, GPT-4, Gemini, and more
- **Page Analysis**: Summarize, explain, and query any webpage
- **Selection Actions**: Right-click menu for AI operations on selected text
- **MCP Integration**: Access 260+ MCP tools from your browser
- **Cloud Sync**: Sync conversations and settings via cloud.hanzo.ai

## Installation

### Chrome / Edge / Brave

1. Download the latest release from [Releases](https://github.com/hanzoai/browser-extension/releases)
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `dist` folder

### Firefox

1. Download the latest release
2. Open `about:debugging`
3. Click "This Firefox" → "Load Temporary Add-on"
4. Select `manifest.json`

### Safari

1. Enable developer mode in Safari preferences
2. Download the macOS app version from [Releases](https://github.com/hanzoai/browser-extension/releases)
3. Open the app and enable the extension in Safari preferences

## Development

```bash
# Install dependencies
npm install

# Build extension
npm run build

# Watch mode for development
npm run watch

# Run tests
npm test
```

## Building for Production

```bash
# Build for all browsers
npm run build

# The dist/ folder contains the extension ready for loading
```

## Project Structure

```
browser-extension/
├── src/
│   ├── background/    # Service worker / background script
│   ├── content/       # Content scripts injected into pages
│   ├── popup/         # Extension popup UI
│   ├── sidebar/       # AI chat sidebar
│   └── shared/        # Shared utilities
├── dist/              # Built extension
├── manifest.json      # Extension manifest (MV3)
├── package.json
└── tsconfig.json
```

## Configuration

### API Keys

The extension uses your Hanzo AI account for API access. Login at:
- [cloud.hanzo.ai](https://cloud.hanzo.ai) - Cloud dashboard
- [iam.hanzo.ai](https://iam.hanzo.ai) - API key management

Or set environment variables for direct provider access:
- `ANTHROPIC_API_KEY` - Claude models
- `OPENAI_API_KEY` - GPT models
- `GOOGLE_API_KEY` - Gemini models

### Permissions

The extension requests minimal permissions:
- `activeTab` - Access to current tab when activated
- `storage` - Store settings and conversations locally
- `contextMenus` - Right-click menu integration

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Content Script  │ ◄──► │ Background       │ ◄──► │ Hanzo API       │
│ (Page Context)  │     │ (Service Worker) │     │ (api.hanzo.ai)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                      │
         │                      │
         ▼                      ▼
┌─────────────────┐     ┌──────────────────┐
│ Popup / Sidebar │     │ MCP Bridge       │
│ (React UI)      │     │ (WebSocket)      │
└─────────────────┘     └──────────────────┘
```

## Related Projects

- [ide-extension](https://github.com/hanzoai/ide-extension) - VS Code and JetBrains plugins
- [hanzo-mcp](https://github.com/hanzoai/mcp) - Model Context Protocol tools
- [hanzo.vim](https://github.com/hanzoai/hanzo.vim) - Vim/Neovim plugin
- [hanzo.el](https://github.com/hanzoai/hanzo.el) - Emacs package

## License

MIT - See [LICENSE](LICENSE)
