// Background Service Worker for Browser Extension
import { BrowserControl } from './browser-control';
import { WebGPUAI } from './webgpu-ai';
import { getCDPBridge, CDPBridge } from './cdp-bridge';
import * as auth from './auth';
import { listModels, chatCompletion, ChatMessage } from './chat-client';

// Initialize browser control
const browserControl = new BrowserControl();
const webgpuAI = new WebGPUAI();

// Initialize CDP bridge for hanzo-mcp integration
const cdpBridge: CDPBridge = getCDPBridge();

// =============================================================================
// ZAP Protocol Integration
// =============================================================================

/** ZAP connection state */
interface ZapState {
  connected: boolean;
  mcps: Array<{ id: string; name: string; url: string; tools: string[] }>;
  extensionId: string;
}

interface ControlSession {
  active: boolean;
  tabId: number | null;
  task: string | null;
  startedAt: number | null;
}

interface RagSnippet {
  content: string;
  title?: string;
  source?: string;
  score?: number;
  url?: string;
}

interface RagQueryParams {
  query: string;
  topK: number;
  knowledgeBase: string;
  includeTabContext: boolean;
  useZapMemory: boolean;
  endpoint: string;
  apiKey: string;
  mcpId?: string;
  pageContext?: {
    url?: string;
    title?: string;
  };
}

const zapState: ZapState = {
  connected: false,
  mcps: [],
  extensionId: `hanzo-ext-${Date.now().toString(36)}`,
};

const controlSession: ControlSession = {
  active: false,
  tabId: null,
  task: null,
  startedAt: null,
};

// Default ports (overridable via chrome.storage.local settings)
const DEFAULT_ZAP_PORTS = [9999, 9998, 9997, 9996, 9995];
const DEFAULT_MCP_PORT = 3001;
const DEFAULT_CDP_PORT = 9223;
const ZAP_RECONNECT_DELAY = 3000;
const ZAP_DISCOVERY_TIMEOUT = 2000;
const DEFAULT_RAG_TOP_K = 5;

/** Load port configuration from storage */
async function getPortConfig(): Promise<{ zapPorts: number[]; mcpPort: number; cdpPort: number }> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['zapPorts', 'mcpPort', 'cdpPort'], (result) => {
      resolve({
        zapPorts: result.zapPorts || DEFAULT_ZAP_PORTS,
        mcpPort: result.mcpPort || DEFAULT_MCP_PORT,
        cdpPort: result.cdpPort || DEFAULT_CDP_PORT,
      });
    });
  });
}

async function getRagConfig(): Promise<{
  endpoint: string;
  apiKey: string;
  knowledgeBase: string;
  topK: number;
  includeTabContext: boolean;
  useZapMemory: boolean;
}> {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'hanzo_rag_endpoint',
      'hanzo_rag_api_key',
      'hanzo_rag_kb',
      'hanzo_rag_top_k',
      'hanzo_rag_include_tab_context',
      'hanzo_rag_use_zap',
    ], (result) => {
      const parsedTopK = Number.parseInt(String(result.hanzo_rag_top_k ?? DEFAULT_RAG_TOP_K), 10);
      resolve({
        endpoint: String(result.hanzo_rag_endpoint || '').trim(),
        apiKey: String(result.hanzo_rag_api_key || '').trim(),
        knowledgeBase: String(result.hanzo_rag_kb || '').trim(),
        topK: Number.isFinite(parsedTopK) ? Math.max(1, Math.min(parsedTopK, 20)) : DEFAULT_RAG_TOP_K,
        includeTabContext: result.hanzo_rag_include_tab_context !== false,
        useZapMemory: result.hanzo_rag_use_zap !== false,
      });
    });
  });
}

/** Active ZAP WebSocket connections keyed by MCP id */
const zapConnections = new Map<string, WebSocket>();

/**
 * ZAP Protocol handshake message
 * Binary format: [ZAP\x01][type:1][length:4][payload]
 */
const ZAP_MAGIC = new Uint8Array([0x5A, 0x41, 0x50, 0x01]); // "ZAP\x01"
const MSG_HANDSHAKE    = 0x01;
const MSG_HANDSHAKE_OK = 0x02;
const MSG_REQUEST      = 0x10;
const MSG_RESPONSE     = 0x11;
const MSG_PING         = 0xFE;
const MSG_PONG         = 0xFF;

function encodeZapMessage(type: number, payload: object): ArrayBuffer {
  const json = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const data = encoder.encode(json);
  const buf = new ArrayBuffer(4 + 1 + 4 + data.length);
  const view = new DataView(buf);
  // Magic
  new Uint8Array(buf, 0, 4).set(ZAP_MAGIC);
  // Type
  view.setUint8(4, type);
  // Length (big-endian)
  view.setUint32(5, data.length, false);
  // Payload
  new Uint8Array(buf, 9).set(data);
  return buf;
}

function decodeZapMessage(buf: ArrayBuffer): { type: number; payload: any } | null {
  if (buf.byteLength < 9) return null;
  const view = new DataView(buf);
  const magic = new Uint8Array(buf, 0, 4);
  if (magic[0] !== 0x5A || magic[1] !== 0x41 || magic[2] !== 0x50 || magic[3] !== 0x01) {
    return null; // Not a ZAP message — try JSON fallback
  }
  const type = view.getUint8(4);
  const length = view.getUint32(5, false);
  const decoder = new TextDecoder();
  const json = decoder.decode(new Uint8Array(buf, 9, length));
  return { type, payload: JSON.parse(json) };
}

/**
 * Probe a ZAP server on given port
 */
function probeZapServer(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `ws://localhost:${port}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); resolve(null); }, ZAP_DISCOVERY_TIMEOUT);

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      clearTimeout(timer);
      // Send handshake
      ws.send(encodeZapMessage(MSG_HANDSHAKE, {
        clientId: zapState.extensionId,
        clientType: 'browser_extension',
        browser: detectBrowser(),
        version: chrome.runtime.getManifest().version,
        capabilities: ['tabs', 'navigate', 'screenshot', 'evaluate', 'cookies', 'storage'],
      }));

      // Wait for handshake response
      const hsTimer = setTimeout(() => { ws.close(); resolve(null); }, ZAP_DISCOVERY_TIMEOUT);
      ws.onmessage = (ev) => {
        clearTimeout(hsTimer);
        ws.close();
        resolve(url);
      };
    };
    ws.onerror = () => { clearTimeout(timer); resolve(null); };
  });
}

/**
 * Connect to a ZAP server and set up message handling
 */
async function connectZap(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const connTimer = setTimeout(() => { ws.close(); resolve(null); }, 10000);

    ws.onopen = () => {
      // Send handshake
      ws.send(encodeZapMessage(MSG_HANDSHAKE, {
        clientId: zapState.extensionId,
        clientType: 'browser_extension',
        browser: detectBrowser(),
        version: chrome.runtime.getManifest().version,
        capabilities: ['tabs', 'navigate', 'screenshot', 'evaluate', 'cookies', 'storage'],
      }));
    };

    ws.onmessage = (ev) => {
      // Handle both binary ZAP and JSON fallback
      let msg: { type: number; payload: any } | null = null;
      if (ev.data instanceof ArrayBuffer) {
        msg = decodeZapMessage(ev.data);
      }
      if (!msg && typeof ev.data === 'string') {
        // JSON fallback for MCP servers that don't speak binary ZAP
        try {
          const json = JSON.parse(ev.data);
          handleMCPMessage(json);
          return;
        } catch { return; }
      }
      if (!msg) return;

      switch (msg.type) {
        case MSG_HANDSHAKE_OK: {
          clearTimeout(connTimer);
          const info = msg.payload;
          const mcpId = info.serverId || `mcp-${Date.now().toString(36)}`;
          zapConnections.set(mcpId, ws);
          zapState.connected = true;
          zapState.mcps.push({
            id: mcpId,
            name: info.name || `MCP@${url}`,
            url,
            tools: (info.tools || []).map((t: any) => t.name),
          });
          console.log(`[Hanzo/ZAP] Connected to ${info.name || url} (${(info.tools || []).length} tools)`);
          resolve(mcpId);
          break;
        }
        case MSG_RESPONSE: {
          // Route responses to pending requests
          const { id, result, error } = msg.payload;
          const pending = pendingRequests.get(id);
          if (pending) {
            pendingRequests.delete(id);
            if (error) pending.reject(new Error(error.message || error));
            else pending.resolve(result);
          }
          break;
        }
        case MSG_PING:
          ws.send(encodeZapMessage(MSG_PONG, {}));
          break;
      }
    };

    ws.onclose = () => {
      // Remove from connections
      for (const [id, conn] of zapConnections) {
        if (conn === ws) {
          zapConnections.delete(id);
          zapState.mcps = zapState.mcps.filter(m => m.id !== id);
          break;
        }
      }
      zapState.connected = zapConnections.size > 0;
      console.log(`[Hanzo/ZAP] Disconnected from ${url}, reconnecting in ${ZAP_RECONNECT_DELAY}ms...`);
      setTimeout(() => connectZap(url), ZAP_RECONNECT_DELAY);
    };

    ws.onerror = () => {
      clearTimeout(connTimer);
      resolve(null);
    };
  });
}

/** Pending ZAP RPC requests */
const pendingRequests = new Map<string, { resolve: Function; reject: Function }>();
let requestIdCounter = 0;

/**
 * Send a ZAP RPC request to an MCP server
 */
function zapRequest(mcpId: string, method: string, params: any = {}): Promise<any> {
  const ws = zapConnections.get(mcpId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`MCP ${mcpId} not connected`));
  }

  const id = `req-${++requestIdCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`ZAP request timeout: ${method}`));
    }, 30000);

    pendingRequests.set(id, {
      resolve: (r: any) => { clearTimeout(timer); resolve(r); },
      reject:  (e: any) => { clearTimeout(timer); reject(e); },
    });

    ws.send(encodeZapMessage(MSG_REQUEST, { id, method, params }));
  });
}

/**
 * Call a tool via ZAP on the first MCP that has it
 */
async function zapCallTool(name: string, args: Record<string, unknown> = {}, targetMcpId?: string): Promise<any> {
  if (targetMcpId) {
    return zapRequest(targetMcpId, 'tools/call', { name, arguments: args });
  }
  // Find first MCP that has the tool
  for (const mcp of zapState.mcps) {
    if (mcp.tools.includes(name)) {
      return zapRequest(mcp.id, 'tools/call', { name, arguments: args });
    }
  }
  throw new Error(`Tool not found on any ZAP-connected MCP: ${name}`);
}

function hasZapTool(name: string): boolean {
  return zapState.mcps.some((mcp) => mcp.tools.includes(name));
}

function normalizeRagSnippets(raw: any): RagSnippet[] {
  if (!raw) return [];

  const candidates: any[] = [];
  if (Array.isArray(raw)) candidates.push(...raw);
  if (Array.isArray(raw?.snippets)) candidates.push(...raw.snippets);
  if (Array.isArray(raw?.documents)) candidates.push(...raw.documents);
  if (Array.isArray(raw?.items)) candidates.push(...raw.items);
  if (Array.isArray(raw?.results)) candidates.push(...raw.results);
  if (Array.isArray(raw?.memories)) candidates.push(...raw.memories);
  if (Array.isArray(raw?.matches)) candidates.push(...raw.matches);

  if (!candidates.length && typeof raw?.content === 'string') {
    candidates.push({ content: raw.content, source: raw.source || 'memory' });
  }

  const snippets = candidates
    .map((item) => {
      const content = String(
        item?.content ??
        item?.text ??
        item?.snippet ??
        item?.body ??
        item?.value ??
        '',
      ).trim();
      if (!content) return null;

      return {
        content,
        title: item?.title ? String(item.title) : undefined,
        source: item?.source ? String(item.source) : undefined,
        score: typeof item?.score === 'number' ? item.score : undefined,
        url: item?.url ? String(item.url) : undefined,
      } as RagSnippet;
    })
    .filter((item): item is RagSnippet => !!item);

  return snippets.slice(0, 20);
}

async function queryRagFromZap(params: RagQueryParams): Promise<RagSnippet[]> {
  if (!params.useZapMemory || !zapState.connected || !hasZapTool('memory')) {
    return [];
  }

  const payloads: Record<string, unknown>[] = [
    {
      action: 'query',
      query: params.query,
      top_k: params.topK,
      limit: params.topK,
      kb: params.knowledgeBase || undefined,
      page_context: params.pageContext,
    },
    {
      query: params.query,
      topK: params.topK,
      limit: params.topK,
      knowledge_base: params.knowledgeBase || undefined,
      context: params.pageContext,
    },
  ];

  for (const payload of payloads) {
    try {
      const raw = await zapCallTool('memory', payload, params.mcpId);
      const snippets = normalizeRagSnippets(raw);
      if (snippets.length) {
        return snippets.map((snippet) => ({
          ...snippet,
          source: snippet.source || 'zap-memory',
        }));
      }
    } catch {
      // Try alternative payload shape before giving up.
    }
  }

  return [];
}

async function queryRagFromEndpoint(params: RagQueryParams): Promise<RagSnippet[]> {
  if (!params.endpoint) return [];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const response = await fetch(params.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: params.query,
      top_k: params.topK,
      knowledge_base: params.knowledgeBase || undefined,
      page_context: params.includeTabContext ? params.pageContext : undefined,
      source: 'hanzo-browser-extension',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RAG endpoint error ${response.status}: ${text || 'Unknown error'}`);
  }

  const raw = await response.json();
  return normalizeRagSnippets(raw).map((snippet) => ({
    ...snippet,
    source: snippet.source || 'rag-endpoint',
  }));
}

/**
 * Discover and connect to ZAP servers on startup
 */
async function discoverZapServers() {
  console.log('[Hanzo/ZAP] Discovering MCP servers...');
  const { zapPorts } = await getPortConfig();
  const results = await Promise.all(zapPorts.map(p => probeZapServer(p)));
  const available = results.filter(Boolean) as string[];

  if (available.length === 0) {
    console.log('[Hanzo/ZAP] No servers found, retrying in 10s...');
    setTimeout(discoverZapServers, 10000);
    return;
  }

  console.log(`[Hanzo/ZAP] Found ${available.length} server(s): ${available.join(', ')}`);
  await Promise.all(available.map(url => connectZap(url)));
}

function detectBrowser(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';
  return 'unknown';
}

function sendControlMessageToTab(tabId: number, message: Record<string, unknown>): void {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      // Content script may not be injected on privileged pages.
    }
  });
}

function sendMessageToTab(tabId: number, message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Failed to contact page content script'));
        return;
      }
      resolve(response);
    });
  });
}

function getActiveTabId(): Promise<number | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

async function resolveControlTabId(tabId?: number): Promise<number | null> {
  if (typeof tabId === 'number') return tabId;
  if (controlSession.active && controlSession.tabId !== null) return controlSession.tabId;
  return getActiveTabId();
}

async function startControlSession(tabId: number, task?: string): Promise<void> {
  if (controlSession.active && controlSession.tabId !== null && controlSession.tabId !== tabId) {
    sendControlMessageToTab(controlSession.tabId, { action: 'ai.control.stop' });
  }

  controlSession.active = true;
  controlSession.tabId = tabId;
  controlSession.task = task || 'AI is controlling this page';
  controlSession.startedAt = Date.now();

  sendControlMessageToTab(tabId, {
    action: 'ai.control.start',
    task: controlSession.task,
  });
}

async function stopControlSession(): Promise<void> {
  if (controlSession.active && controlSession.tabId !== null) {
    sendControlMessageToTab(controlSession.tabId, { action: 'ai.control.stop' });
  }
  controlSession.active = false;
  controlSession.tabId = null;
  controlSession.task = null;
  controlSession.startedAt = null;
}

// =============================================================================
// Extension Lifecycle
// =============================================================================

// Initialize WebGPU and CDP on install
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Hanzo] Extension installed, initializing...');

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

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(request: any, sender: chrome.runtime.MessageSender, sendResponse: Function) {
  switch (request.action) {
    // --- ZAP Protocol actions ---
    case 'zap.status':
      sendResponse({ success: true, zap: zapState });
      break;

    case 'zap.discover':
      discoverZapServers().then(() => sendResponse({ success: true, mcps: zapState.mcps }));
      break;

    case 'zap.connect':
      try {
        const mcpId = await connectZap(request.url);
        sendResponse({ success: !!mcpId, mcpId });
      } catch (e: any) {
        sendResponse({ success: false, error: e.message });
      }
      break;

    case 'zap.callTool':
      try {
        const result = await zapCallTool(request.name, request.args, request.mcpId);
        sendResponse({ success: true, result });
      } catch (e: any) {
        sendResponse({ success: false, error: e.message });
      }
      break;

    case 'zap.listTools': {
      const tools = zapState.mcps.flatMap(m => m.tools.map(t => ({ name: t, mcpId: m.id, mcpName: m.name })));
      sendResponse({ success: true, tools });
      break;
    }

    // --- Local AI ---
    case 'runLocalAI':
      try {
        const result = await webgpuAI.runInference(request.model || 'hanzo-browser-control', request.prompt);
        sendResponse({ success: true, result });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'checkWebGPU': {
      try {
        if (!navigator.gpu) {
          sendResponse({ available: false });
          break;
        }
        const adapter = await navigator.gpu.requestAdapter();
        sendResponse({
          available: !!adapter,
          adapter: (adapter as any)?.name || 'Unknown GPU',
          models: webgpuAI.getStatus().models,
        });
      } catch {
        sendResponse({ available: false });
      }
      break;
    }

    case 'listAgents':
      sendResponse({ success: true, agents: browserControl.getAgents() });
      break;

    case 'stopAgent':
      sendResponse({ success: browserControl.stopAgent(request.agentId) });
      break;

    case 'launchAIWorker':
      try {
        const targetTabId = request.tabId || sender.tab?.id;
        if (!targetTabId) {
          sendResponse({ success: false, error: 'No target tab found' });
          break;
        }
        const agentId = await browserControl.launchAIWorker(targetTabId, request.model || 'browser-control');
        sendResponse({ success: true, agentId });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    // --- Tab Filesystem ---
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

    // --- CDP bridge commands ---
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

    // --- AI Control Overlay ---
    case 'ai.control.start': {
      const tabId = await resolveControlTabId(request.tabId);
      if (tabId === null) {
        sendResponse({ success: false, error: 'No target tab found' });
        break;
      }
      await startControlSession(tabId, request.task);
      sendResponse({
        success: true,
        session: {
          active: controlSession.active,
          tabId: controlSession.tabId,
          task: controlSession.task,
          startedAt: controlSession.startedAt,
        },
      });
      break;
    }

    case 'ai.control.stop': {
      await stopControlSession();
      sendResponse({ success: true });
      break;
    }

    case 'ai.control.cursor':
    case 'ai.control.highlight':
    case 'ai.control.status': {
      const tabId = await resolveControlTabId(request.tabId);
      if (tabId === null) {
        sendResponse({ success: false, error: 'No target tab found' });
        break;
      }
      if (controlSession.active && controlSession.tabId !== null && tabId !== controlSession.tabId) {
        sendResponse({
          success: false,
          error: `Control locked to tab ${controlSession.tabId}`,
        });
        break;
      }
      sendControlMessageToTab(tabId, request);
      sendResponse({ success: true, tabId });
      break;
    }

    case 'ai.control.cancel':
      // User clicked Stop — notify ZAP/MCP to cancel current task
      await stopControlSession();
      if (zapState.connected) {
        for (const [, conn] of zapConnections) {
          if (conn.readyState === WebSocket.OPEN) {
            conn.send(encodeZapMessage(MSG_REQUEST, {
              id: `cancel-${++requestIdCounter}`,
              method: 'notifications/controlCancelled',
              params: {},
            }));
          }
        }
      }
      sendResponse({ success: true });
      break;

    // --- In-page overlay (content script) ---
    case 'page.overlay.toggle':
    case 'page.overlay.show':
    case 'page.overlay.hide':
    case 'page.overlay.status': {
      try {
        const tabId = typeof request.tabId === 'number'
          ? request.tabId
          : (sender.tab?.id ?? await getActiveTabId());
        if (tabId === null) {
          sendResponse({ success: false, error: 'No target tab found' });
          break;
        }

        const response = await sendMessageToTab(tabId, { action: request.action });
        sendResponse({ success: true, tabId, ...(response || {}) });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;
    }

    // --- Auth (Hanzo IAM OAuth2 + PKCE) ---
    case 'auth.login':
      try {
        const user = await auth.login();
        sendResponse({ success: true, user });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'auth.logout':
      try {
        await auth.logout();
        sendResponse({ success: true });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'auth.status':
      try {
        const status = await auth.getAuthStatus();
        sendResponse({ success: true, ...status });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'auth.getToken':
      try {
        const token = await auth.getValidAccessToken();
        sendResponse({ success: !!token, token });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'rag.query':
      try {
        const config = await getRagConfig();
        const topKInput = Number.parseInt(String(request.topK ?? config.topK), 10);
        const params: RagQueryParams = {
          query: String(request.query || '').trim(),
          topK: Number.isFinite(topKInput) ? Math.max(1, Math.min(topKInput, 20)) : DEFAULT_RAG_TOP_K,
          knowledgeBase: String(request.knowledgeBase ?? config.knowledgeBase ?? '').trim(),
          includeTabContext: request.includeTabContext !== undefined
            ? !!request.includeTabContext
            : config.includeTabContext,
          useZapMemory: request.useZapMemory !== undefined
            ? !!request.useZapMemory
            : config.useZapMemory,
          endpoint: String(request.endpoint ?? config.endpoint ?? '').trim(),
          apiKey: String(request.apiKey ?? config.apiKey ?? '').trim(),
          mcpId: request.mcpId ? String(request.mcpId) : undefined,
          pageContext: request.pageContext && typeof request.pageContext === 'object'
            ? {
                url: request.pageContext.url ? String(request.pageContext.url) : undefined,
                title: request.pageContext.title ? String(request.pageContext.title) : undefined,
              }
            : undefined,
        };

        if (!params.query) {
          sendResponse({ success: false, error: 'Query is required' });
          break;
        }

        let snippets = await queryRagFromZap(params);
        let source = snippets.length ? 'zap-memory' : 'none';

        if (!snippets.length && params.endpoint) {
          snippets = await queryRagFromEndpoint(params);
          source = snippets.length ? 'rag-endpoint' : source;
        }

        sendResponse({
          success: true,
          source,
          snippets: snippets.slice(0, params.topK),
        });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    // --- Cloud Chat ---
    case 'chat.listModels':
      try {
        const token = await auth.getValidAccessToken();
        if (!token) {
          sendResponse({ success: false, error: 'Not authenticated' });
          break;
        }
        const models = await listModels(token);
        sendResponse({ success: true, models });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'chat.complete':
      try {
        const token = await auth.getValidAccessToken();
        if (!token) {
          sendResponse({ success: false, error: 'Not authenticated' });
          break;
        }

        const model = String(request.model || 'gpt-4o');
        const messagesInput = Array.isArray(request.messages) ? request.messages : [];
        const messages: ChatMessage[] = messagesInput
          .filter((msg: any) => msg && typeof msg.content === 'string' && typeof msg.role === 'string')
          .map((msg: any) => ({
            role: (msg.role === 'system' || msg.role === 'assistant') ? msg.role : 'user',
            content: String(msg.content),
          }))
          .slice(-24);

        if (!messages.length) {
          sendResponse({ success: false, error: 'messages are required' });
          break;
        }

        const content = await chatCompletion(token, {
          model,
          messages,
          temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
          max_tokens: typeof request.max_tokens === 'number' ? request.max_tokens : undefined,
        });

        sendResponse({ success: true, content });
      } catch (error: any) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    // --- Bridge status ---
    case 'bridge.status': {
      const bridgeConnected = cdpBridge.isBridgeConnected();
      sendResponse({
        success: true,
        connected: bridgeConnected,
        browsers: bridgeConnected ? [detectBrowser()] : [],
      });
      break;
    }

    // --- Config persistence ---
    case 'config.save': {
      const { key, value } = request;
      // Forward to CDP bridge server so it can save to ~/.hanzo/extension/config.json
      cdpBridge.sendConfig(key, value);
      sendResponse({ success: true });
      break;
    }

    // --- Takeover messages (forwarded from CDP bridge to content script) ---
    case 'hanzo.takeover.start': {
      const takeoverTabId = await resolveControlTabId(request.tabId);
      if (takeoverTabId === null) {
        sendResponse({ success: false, error: 'No target tab found' });
        break;
      }
      await startControlSession(takeoverTabId, request.task);
      sendResponse({ success: true });
      break;
    }

    case 'hanzo.takeover.end': {
      await stopControlSession();
      sendResponse({ success: true });
      break;
    }

    case 'hanzo.takeover.cursor': {
      const cursorTabId = await resolveControlTabId(request.tabId);
      if (cursorTabId !== null) {
        sendControlMessageToTab(cursorTabId, {
          action: 'ai.control.cursor',
          x: request.x,
          y: request.y,
        });
      }
      sendResponse({ success: true });
      break;
    }

    // --- Content script element selection (routed from content script) ---
    case 'elementSelected':
      // Forward to ZAP-connected MCPs (primary)
      if (zapState.connected) {
        for (const [, conn] of zapConnections) {
          if (conn.readyState === WebSocket.OPEN) {
            conn.send(encodeZapMessage(MSG_REQUEST, {
              id: `evt-${++requestIdCounter}`,
              method: 'notifications/elementSelected',
              params: request.data,
            }));
          }
        }
      }
      // Also forward to legacy MCP WebSocket (fallback)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(request.data));
      }
      sendResponse({ success: true });
      break;

  }
}

// =============================================================================
// Legacy MCP WebSocket (fallback when no ZAP gateway running)
// =============================================================================

let ws: WebSocket | null = null;

async function connectToMCP() {
  const { mcpPort } = await getPortConfig();
  ws = new WebSocket(`ws://localhost:${mcpPort}/browser-extension`);

  ws.onopen = () => {
    console.log('[Hanzo] Connected to legacy MCP server');
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMCPMessage(data);
  };

  ws.onerror = () => {
    // Silent — ZAP is primary, this is fallback
  };

  ws.onclose = () => {
    setTimeout(connectToMCP, 5000);
  };
}

function handleMCPMessage(data: any) {
  switch (data.type) {
    case 'browserControl':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          browserControl.launchAIWorker(tabs[0].id, data.model);
        }
      });
      break;
  }
}

// =============================================================================
// Startup
// =============================================================================

// 0. Register side panel
if (chrome.sidePanel) {
  chrome.sidePanel.setOptions({ path: 'sidebar.html', enabled: true });
}

// End active session when the controlled tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (controlSession.active && controlSession.tabId === tabId) {
    void stopControlSession();
  }
});

// 1. Primary: Discover ZAP servers (high-performance binary protocol)
discoverZapServers();

// 2. Fallback: Connect to legacy MCP WebSocket
connectToMCP();

// 3. CDP bridge for browser control (configurable port)
getPortConfig().then(({ cdpPort }) => {
  try {
    cdpBridge.startWebSocketServer(cdpPort);
    console.log(`[Hanzo] CDP bridge connecting to ws://localhost:${cdpPort}/cdp`);
  } catch (e) {
    console.error('[Hanzo] Failed to start CDP bridge:', e);
  }
});

// Export for testing
export { browserControl, webgpuAI, zapState, zapCallTool };
