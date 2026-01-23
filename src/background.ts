// Background Service Worker for Browser Extension
import { BrowserControl } from './browser-control';
import { WebGPUAI } from './webgpu-ai';
import { getCDPBridge, CDPBridge } from './cdp-bridge';

// Initialize browser control
const browserControl = new BrowserControl();
const webgpuAI = new WebGPUAI();

// Initialize CDP bridge for hanzo-mcp integration
const cdpBridge: CDPBridge = getCDPBridge();

// Initialize WebGPU and CDP on startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Hanzo] Extension installed, initializing...');
  
  // Initialize CDP bridge for hanzo-mcp browser tool integration
  // Default port 9223 (one above Chrome's default 9222)
  const cdpPort = parseInt(process.env.HANZO_CDP_PORT || '9223');
  cdpBridge.startWebSocketServer(cdpPort);
  console.log(`[Hanzo] CDP bridge connecting to ws://localhost:${cdpPort}/cdp`);
  
  const gpuAvailable = await webgpuAI.initialize();
  if (gpuAvailable) {
    console.log('[Hanzo] WebGPU available, loading local models...');
    
    // Load small local model for browser control
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
      } catch (error) {
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
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'writeTabFS':
      try {
        await browserControl.writeTab(request.path, request.content);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'listTabFS':
      const tabs = await browserControl.listTabs();
      sendResponse({ success: true, tabs });
      break;
      
    // CDP bridge commands for hanzo-mcp integration
    case 'cdp.attach':
      try {
        const attached = await cdpBridge.attach(request.tabId);
        sendResponse({ success: attached });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.detach':
      try {
        await cdpBridge.detach(request.tabId);
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.send':
      try {
        const result = await cdpBridge.send(request.tabId, request.method, request.params);
        sendResponse({ success: true, result });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.screenshot':
      try {
        const screenshot = await cdpBridge.screenshot(request.tabId, request.options);
        sendResponse({ success: true, data: screenshot });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.click':
      try {
        const clicked = await cdpBridge.clickSelector(request.tabId, request.selector);
        sendResponse({ success: clicked });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.fill':
      try {
        const filled = await cdpBridge.fillSelector(request.tabId, request.selector, request.value);
        sendResponse({ success: filled });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.navigate':
      try {
        await cdpBridge.navigate(request.tabId, request.url);
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
      
    case 'cdp.evaluate':
      try {
        const evalResult = await cdpBridge.evaluate(request.tabId, request.expression);
        sendResponse({ success: true, result: evalResult });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
  }
}

// Connect to WebSocket for MCP communication
let ws: WebSocket | null = null;

function connectToMCP() {
  ws = new WebSocket('ws://localhost:3001/browser-extension');
  
  ws.onopen = () => {
    console.log('[Hanzo] Connected to MCP server');
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMCPMessage(data);
  };
  
  ws.onerror = (error) => {
    console.error('[Hanzo] WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('[Hanzo] Disconnected from MCP server, reconnecting...');
    setTimeout(connectToMCP, 5000);
  };
}

function handleMCPMessage(data: any) {
  switch (data.type) {
    case 'browserControl':
      // Execute browser control commands from MCP
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          browserControl.launchAIWorker(tabs[0].id, data.model);
        }
      });
      break;
  }
}

// Connect on startup
connectToMCP();

// Also connect CDP bridge immediately (not just on install)
// This ensures it works for temporary extensions in Firefox
// Note: process.env may not exist in browser extensions
const cdpPort = 9223;
try {
  cdpBridge.startWebSocketServer(cdpPort);
  console.log(`[Hanzo] CDP bridge connecting to ws://localhost:${cdpPort}/cdp`);
} catch (e) {
  console.error('[Hanzo] Failed to start CDP bridge:', e);
}

// Export for testing
export { browserControl, webgpuAI };