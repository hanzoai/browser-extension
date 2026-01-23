---
title: Hanzo AI Browser Extension
description: AI-powered browser extension for Chrome, Firefox, Edge, Safari
---

# Hanzo AI Browser Extension

AI-powered browser extension with support for Claude, GPT-4, Gemini, and more.

## Installation

### Chrome / Edge / Brave

1. Download from [Releases](https://github.com/hanzoai/browser-extension/releases)
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select `dist` folder

### Firefox

1. Download release
2. Open `about:debugging`
3. Click "This Firefox" → "Load Temporary Add-on"
4. Select `manifest.json`

## Features

- **AI Chat Sidebar**: Chat with Claude, GPT-4, Gemini
- **Page Analysis**: Summarize, explain, query any webpage
- **Selection Actions**: Right-click AI operations
- **MCP Integration**: 260+ MCP tools
- **Cloud Sync**: Sync via cloud.hanzo.ai

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Content Script  │ ◄──► │ Background       │ ◄──► │ Hanzo API       │
│ (Page Context)  │     │ (Service Worker) │     │ (api.hanzo.ai)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Development

```bash
npm install
npm run build
npm run watch  # Development mode
npm test
```

## Configuration

Login at [cloud.hanzo.ai](https://cloud.hanzo.ai) to sync settings.
