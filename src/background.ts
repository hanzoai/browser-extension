// Background Service Worker for Browser Extension
// Using ZAP protocol for direct browser extension <> MCP server communication
import { BrowserControl } from './browser-control';
import { WebGPUAI } from './webgpu-ai';
import { ZapExtensionClient, type McpInfo, type ToolResult } from './zap-client';

// Initialize browser control
const browserControl = new BrowserControl();
const webgpuAI = new WebGPUAI();

// Initialize ZAP client for direct MCP connection (no middle server)
const zapClient = new ZapExtensionClient({
  browser: detectBrowser(),
  version: chrome.runtime.getManifest().version,
  capabilities: [
    'tabs',
    'navigate',
    'screenshot',
    'evaluate',
    'click',
    'fill',
    'cookies',
    'storage',
  ],
  autoReconnect: true,
});

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';
  return 'unknown';
}

// Initialize WebGPU on startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Hanzo] Extension installed, initializing...');

  // Initialize ZAP connections
  await initializeZap();

  const gpuAvailable = await webgpuAI.initialize();
  if (gpuAvailable) {
    console.log('[Hanzo] WebGPU available, loading local models...');

    try {
      await webgpuAI.loadModel({
        name: 'hanzo-browser-control',
        url: chrome.runtime.getURL('models/browser-control-4bit.bin'),
        quantization: '4bit',
        maxTokens: 512
      });
    } catch (error) {
      console.error('[Hanzo] Failed to load local model:', error);
    }
  }
});

// Initialize ZAP client and discover MCP servers
async function initializeZap() {
  console.log('[Hanzo] Initializing ZAP client...');

  // Listen for MCP connection events
  zapClient.on('mcp:connect', (mcp: McpInfo) => {
    console.log(`[Hanzo] Connected to MCP: ${mcp.name} (${mcp.url})`);
    console.log(`[Hanzo] Available tools: ${mcp.tools.map(t => t.name).join(', ')}`);
  });

  zapClient.on('mcp:disconnect', (mcp: McpInfo) => {
    console.log(`[Hanzo] Disconnected from MCP: ${mcp.name}`);
  });

  zapClient.on('mcp:reconnect', (mcp: McpInfo) => {
    console.log(`[Hanzo] Reconnected to MCP: ${mcp.name}`);
  });

  // Try to discover and connect to MCP servers
  try {
    // Default ZAP port is 9999
    const defaultPorts = [9999, 9998, 9997, 9223];
    const discovered = await zapClient.discover(defaultPorts, 3000);

    console.log(`[Hanzo] Discovered ${discovered.length} MCP server(s)`);

    // Connect to all discovered servers
    for (const mcp of discovered) {
      try {
        await zapClient.connectMcp(mcp.url);
      } catch (error) {
        console.error(`[Hanzo] Failed to connect to ${mcp.url}:`, error);
      }
    }
  } catch (error) {
    console.error('[Hanzo] MCP discovery failed:', error);
  }

  // Also try known ports explicitly
  const knownUrls = [
    'ws://localhost:9999',  // Default ZAP port
    'ws://localhost:9223',  // Legacy CDP bridge port
  ];

  for (const url of knownUrls) {
    if (!zapClient.mcps.some(m => m.url === url)) {
      try {
        await zapClient.connectMcp(url);
      } catch {
        // Server not available, ignore
      }
    }
  }
}

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(request: any, sender: chrome.runtime.MessageSender, sendResponse: Function) {
  switch (request.action) {
    case 'runLocalAI':
      try {
        const result = await webgpuAI.runInference(
          request.model || 'hanzo-browser-control',
          request.prompt
        );
        sendResponse({ success: true, result });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'launchAIWorker':
      if (sender.tab?.id) {
        await browserControl.launchAIWorker(sender.tab.id, request.model);
        sendResponse({ success: true });
      }
      break;

    case 'readTabFS':
      try {
        const content = await browserControl.readTab(request.path);
        sendResponse({ success: true, content });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'writeTabFS':
      try {
        await browserControl.writeTab(request.path, request.content);
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'listTabFS':
      const tabs = await browserControl.listTabs();
      sendResponse({ success: true, tabs });
      break;

    // =========================================================================
    // ZAP Protocol commands (direct MCP communication)
    // =========================================================================

    case 'zap.connect':
      try {
        const mcp = await zapClient.connectMcp(request.url);
        sendResponse({ success: true, mcp });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'zap.disconnect':
      try {
        await zapClient.disconnectMcp(request.mcpId);
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'zap.listMcps':
      sendResponse({ success: true, mcps: zapClient.mcps });
      break;

    case 'zap.discover':
      try {
        const discovered = await zapClient.discover(request.ports);
        sendResponse({ success: true, mcps: discovered });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'zap.callTool':
      try {
        const result = await zapClient.callTool(request.name, request.args, request.mcpId);
        sendResponse({ success: true, result });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'zap.listTools':
      sendResponse({ success: true, tools: zapClient.getTools() });
      break;

    // =========================================================================
    // Browser control commands (handled by extension, reported to MCPs)
    // =========================================================================

    case 'browser.navigate':
      try {
        await chrome.tabs.update(request.tabId, { url: request.url });
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.screenshot':
      try {
        const screenshot = await chrome.tabs.captureVisibleTab(undefined, {
          format: request.format || 'png',
          quality: request.quality || 90,
        });
        sendResponse({ success: true, data: screenshot });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.click':
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector: string) => {
              const el = document.querySelector(selector);
              if (el instanceof HTMLElement) el.click();
              return !!el;
            },
            args: [request.selector],
          });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No active tab' });
        }
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.fill':
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector: string, value: string) => {
              const el = document.querySelector(selector);
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              }
              return false;
            },
            args: [request.selector, request.value],
          });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No active tab' });
        }
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.evaluate':
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (code: string) => {
              try {
                return { success: true, value: eval(code) };
              } catch (e: any) {
                return { success: false, error: e.message };
              }
            },
            args: [request.code],
          });
          const result = results[0]?.result;
          if (result?.success) {
            sendResponse({ success: true, result: result.value });
          } else {
            sendResponse({ success: false, error: result?.error });
          }
        } else {
          sendResponse({ success: false, error: 'No active tab' });
        }
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.getTabs':
      try {
        const allTabs = await chrome.tabs.query({});
        sendResponse({
          success: true,
          tabs: allTabs.map(t => ({
            tabId: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
            windowId: t.windowId,
          })),
        });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.getCookies':
      try {
        const cookies = await chrome.cookies.getAll({ url: request.url });
        sendResponse({ success: true, cookies });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'browser.getStorage':
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const storage: Record<string, string> = {};
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key) storage[key] = localStorage.getItem(key) || '';
              }
              return storage;
            },
          });
          sendResponse({ success: true, storage: results[0]?.result });
        } else {
          sendResponse({ success: false, error: 'No active tab' });
        }
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
  }
}

// Initialize ZAP on startup (not just on install)
initializeZap().catch(console.error);

// Export for testing
export { browserControl, webgpuAI, zapClient };
