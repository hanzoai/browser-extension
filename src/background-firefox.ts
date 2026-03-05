/**
 * Firefox-specific Background Script for Hanzo Browser Extension
 *
 * Uses shared auth.ts and chat-client.ts modules (unified with Chrome).
 * Firefox provides chrome.* polyfill (since Firefox 101+), so shared
 * modules that use chrome.* work without modification.
 *
 * Firefox-specific differences:
 * - Uses browser.tabs.executeScript instead of chrome.debugger (CDP)
 * - Background is a persistent page, not a service worker
 * - No ZAP binary protocol (WebSocket client only)
 */

// Declare browser API for TypeScript
declare const browser: typeof chrome;

// Shared modules — auth.ts uses chrome.* which Firefox polyfills
import * as auth from './auth';
import { listModels, chatCompletion, ChatMessage } from './chat-client';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface CDPMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
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

const controlSession: ControlSession = {
  active: false,
  tabId: null,
  task: null,
  startedAt: null,
};

// ---------------------------------------------------------------------------
// CDP WebSocket Client (Firefox-specific: client, not server)
// ---------------------------------------------------------------------------

class HanzoFirefoxExtension {
  private wsConnection: WebSocket | null = null;
  private cdpPort: number = 9223;
  private reconnectTimeout: number = 3000;

  constructor() {
    console.log('[Hanzo] Firefox extension initializing...');
    this.loadPort().then(() => this.connect());
  }

  private async loadPort(): Promise<void> {
    try {
      const result = await browser.storage.local.get(['cdpPort']);
      if (result.cdpPort) this.cdpPort = result.cdpPort;
    } catch {}
  }

  private connect(): void {
    const url = `ws://localhost:${this.cdpPort}/cdp`;
    console.log(`[Hanzo] Connecting to ${url}`);

    this.wsConnection = new WebSocket(url);

    this.wsConnection.onopen = () => {
      console.log('[Hanzo] WebSocket CONNECTED');
      this.register();
    };

    this.wsConnection.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data as string) as CDPMessage;
        console.log('[Hanzo] Received:', message.method || 'response');
        const response = await this.handleCommand(message);
        this.send(response);
      } catch (e) {
        console.error('[Hanzo] Message handler error:', e);
        this.send({ id: 0, error: { code: -1, message: String(e) } });
      }
    };

    this.wsConnection.onerror = () => {};

    this.wsConnection.onclose = () => {
      console.log('[Hanzo] Disconnected, reconnecting...');
      setTimeout(() => this.connect(), this.reconnectTimeout);
    };
  }

  isConnected(): boolean {
    return this.wsConnection?.readyState === WebSocket.OPEN;
  }

  sendToWs(data: unknown): void {
    if (this.wsConnection?.readyState === WebSocket.OPEN) {
      this.wsConnection.send(JSON.stringify(data));
    }
  }

  private register(): void {
    this.sendToWs({
      type: 'register',
      role: 'cdp-provider',
      capabilities: [
        'navigate', 'screenshot', 'click', 'type', 'evaluate', 'tabs',
        'fill', 'reload', 'goBack', 'goForward'
      ]
    });
  }

  private send(data: unknown): void {
    this.sendToWs(data);
  }

  private async handleCommand(message: CDPMessage): Promise<CDPResponse> {
    const { id, method, params = {} } = message;
    try {
      const result = await this.executeMethod(method, params);
      return { id, result };
    } catch (e) {
      return { id, error: { code: -1, message: String(e) } };
    }
  }

  private executeScriptWithTimeout(
    tabId: number,
    code: string,
    timeoutMs: number = 10000
  ): Promise<any[]> {
    return Promise.race([
      browser.tabs.executeScript(tabId, { code }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('executeScript timeout')), timeoutMs)
      )
    ]);
  }

  private async executeMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true
    });

    switch (method) {
      case 'Target.getTargets': {
        const allTabs = await browser.tabs.query({});
        return {
          targetInfos: allTabs.map(tab => ({
            targetId: `tab-${tab.id}`,
            type: 'page',
            title: tab.title || '',
            url: tab.url || ''
          }))
        };
      }

      case 'hanzo.url': {
        if (activeTab) return { result: { value: activeTab.url || '' } };
        throw new Error('No active tab');
      }

      case 'hanzo.title': {
        if (activeTab) return { result: { value: activeTab.title || '' } };
        throw new Error('No active tab');
      }

      case 'hanzo.tabInfo': {
        if (activeTab) {
          return {
            result: {
              value: {
                id: activeTab.id,
                url: activeTab.url,
                title: activeTab.title,
                status: activeTab.status,
                favIconUrl: activeTab.favIconUrl
              }
            }
          };
        }
        throw new Error('No active tab');
      }

      case 'Page.navigate': {
        if (activeTab?.id) {
          this.notifyOverlay(activeTab.id, 'ai.control.status', { text: `Navigating to ${params.url}` });
          await browser.tabs.update(activeTab.id, { url: params.url as string });
          return { frameId: 'main' };
        }
        throw new Error('No active tab');
      }

      case 'Page.reload': {
        if (activeTab?.id) {
          await browser.tabs.reload(activeTab.id);
          return { success: true };
        }
        throw new Error('No active tab');
      }

      case 'Page.goBack': {
        if (activeTab?.id) {
          await browser.tabs.goBack(activeTab.id);
          return { success: true };
        }
        throw new Error('No active tab');
      }

      case 'Page.goForward': {
        if (activeTab?.id) {
          await browser.tabs.goForward(activeTab.id);
          return { success: true };
        }
        throw new Error('No active tab');
      }

      case 'Runtime.evaluate': {
        if (activeTab?.id) {
          const expression = params.expression as string;
          const timeout = (params.timeout as number) || 10000;
          const results = await this.executeScriptWithTimeout(activeTab.id, expression, timeout);
          return { result: { value: results[0] } };
        }
        throw new Error('No active tab');
      }

      case 'Page.captureScreenshot':
      case 'hanzo.screenshot': {
        const format = (params.format as string) || 'jpeg';
        const quality = (params.quality as number) || (format === 'jpeg' ? 80 : undefined);
        const opts: any = { format: format as 'png' | 'jpeg' };
        if (quality !== undefined) opts.quality = quality;
        const dataUrl = await browser.tabs.captureVisibleTab(opts);
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        return { data: base64 };
      }

      case 'hanzo.click': {
        if (activeTab?.id && params.selector) {
          const selector = this.escapeSelector(params.selector as string);
          this.notifyOverlay(activeTab.id, 'ai.control.highlight', { selector: params.selector as string });
          this.notifyOverlay(activeTab.id, 'ai.control.status', { text: `Clicking ${params.selector}` });
          await this.executeScriptWithTimeout(activeTab.id,
            `document.querySelector('${selector}')?.click()`
          );
          return { success: true };
        }
        throw new Error('No active tab or selector');
      }

      case 'hanzo.fill': {
        if (activeTab?.id && params.selector) {
          const selector = this.escapeSelector(params.selector as string);
          const value = this.escapeValue((params.value as string) || '');
          this.notifyOverlay(activeTab.id, 'ai.control.highlight', { selector: params.selector as string });
          this.notifyOverlay(activeTab.id, 'ai.control.status', { text: `Filling ${params.selector}` });
          await this.executeScriptWithTimeout(activeTab.id, `
            var el = document.querySelector('${selector}');
            if (el) {
              el.value = '${value}';
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
            }
          `);
          return { success: true };
        }
        throw new Error('No active tab or selector');
      }

      case 'hanzo.control.start': {
        const targetTabId = await this.resolveControlTabId(params.tabId as number | undefined);
        if (targetTabId) {
          await this.startControlSession(targetTabId, params.task as string | undefined);
          return { success: true };
        }
        throw new Error('No active tab');
      }

      case 'hanzo.control.stop': {
        await this.stopControlSession();
        return { success: true };
      }

      case 'hanzo.type': {
        if (activeTab?.id && params.text) {
          const text = this.escapeValue(params.text as string);
          await this.executeScriptWithTimeout(activeTab.id, `
            var el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
              el.value += '${text}';
              el.dispatchEvent(new Event('input', {bubbles: true}));
            }
          `);
          return { success: true };
        }
        throw new Error('No active tab or text');
      }

      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Hanzo Firefox Extension',
          userAgent: navigator.userAgent
        };
      }

      case 'hanzo.getTabs':
      case 'hanzo.listTabs': {
        const tabs = await browser.tabs.query({});
        return {
          tabs: tabs.map(tab => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            active: tab.active
          }))
        };
      }

      default:
        console.warn('[Hanzo] Unknown method:', method);
        return { error: `Unknown method: ${method}` };
    }
  }

  private notifyOverlay(tabId: number, action: string, data: Record<string, unknown>): void {
    browser.tabs.sendMessage(tabId, { action, ...data }).catch(() => {});
  }

  async getActiveTabId(): Promise<number | null> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  }

  async resolveControlTabId(tabId?: number): Promise<number | null> {
    if (typeof tabId === 'number') return tabId;
    if (controlSession.active && controlSession.tabId !== null) return controlSession.tabId;
    return this.getActiveTabId();
  }

  async startControlSession(tabId: number, task?: string): Promise<void> {
    if (controlSession.active && controlSession.tabId !== null && controlSession.tabId !== tabId) {
      this.notifyOverlay(controlSession.tabId, 'ai.control.stop', {});
    }
    controlSession.active = true;
    controlSession.tabId = tabId;
    controlSession.task = task || 'AI is controlling this page';
    controlSession.startedAt = Date.now();
    this.notifyOverlay(tabId, 'ai.control.start', { task: controlSession.task });
  }

  async stopControlSession(): Promise<void> {
    if (controlSession.active && controlSession.tabId !== null) {
      this.notifyOverlay(controlSession.tabId, 'ai.control.stop', {});
    }
    controlSession.active = false;
    controlSession.tabId = null;
    controlSession.task = null;
    controlSession.startedAt = null;
  }

  private escapeSelector(selector: string): string {
    return selector.replace(/'/g, "\\'");
  }

  private escapeValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n');
  }
}

// ---------------------------------------------------------------------------
// RAG (Firefox-only: no ZAP, endpoint-only)
// ---------------------------------------------------------------------------

async function getRagConfig(): Promise<{
  endpoint: string;
  apiKey: string;
  knowledgeBase: string;
  topK: number;
  includeTabContext: boolean;
}> {
  const result = await browser.storage.local.get([
    'hanzo_rag_endpoint',
    'hanzo_rag_api_key',
    'hanzo_rag_kb',
    'hanzo_rag_top_k',
    'hanzo_rag_include_tab_context',
  ]);

  const topKParsed = Number.parseInt(String(result.hanzo_rag_top_k ?? 5), 10);
  return {
    endpoint: String(result.hanzo_rag_endpoint || '').trim(),
    apiKey: String(result.hanzo_rag_api_key || '').trim(),
    knowledgeBase: String(result.hanzo_rag_kb || '').trim(),
    topK: Number.isFinite(topKParsed) ? Math.max(1, Math.min(topKParsed, 20)) : 5,
    includeTabContext: result.hanzo_rag_include_tab_context !== false,
  };
}

function normalizeRagSnippets(raw: any): RagSnippet[] {
  if (!raw) return [];
  const candidates: any[] = [];
  if (Array.isArray(raw)) candidates.push(...raw);
  if (Array.isArray(raw?.snippets)) candidates.push(...raw.snippets);
  if (Array.isArray(raw?.documents)) candidates.push(...raw.documents);
  if (Array.isArray(raw?.items)) candidates.push(...raw.items);
  if (Array.isArray(raw?.results)) candidates.push(...raw.results);
  if (!candidates.length && typeof raw?.content === 'string') {
    candidates.push({ content: raw.content, source: raw.source || 'rag-endpoint' });
  }
  return candidates
    .map((item) => {
      const content = String(item?.content ?? item?.text ?? item?.snippet ?? item?.body ?? '').trim();
      if (!content) return null;
      return {
        content,
        title: item?.title ? String(item.title) : undefined,
        source: item?.source ? String(item.source) : undefined,
        score: typeof item?.score === 'number' ? item.score : undefined,
        url: item?.url ? String(item.url) : undefined,
      } as RagSnippet;
    })
    .filter((item): item is RagSnippet => !!item)
    .slice(0, 20);
}

async function queryRagEndpoint(params: {
  endpoint: string;
  apiKey: string;
  query: string;
  topK: number;
  knowledgeBase: string;
  includeTabContext: boolean;
  pageContext?: { url?: string; title?: string };
}): Promise<RagSnippet[]> {
  if (!params.endpoint) return [];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;
  const response = await fetch(params.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: params.query,
      top_k: params.topK,
      knowledge_base: params.knowledgeBase || undefined,
      page_context: params.includeTabContext ? params.pageContext : undefined,
      source: 'hanzo-browser-extension-firefox',
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

// ---------------------------------------------------------------------------
// Message Handler (unified auth via shared auth.ts)
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((request: any, sender: any, sendResponse: Function) => {
  (async () => {
    switch (request.action) {
      // --- Auth (shared module — same code as Chrome) ---
      case 'auth.login':
        try {
          const user = await auth.login();
          sendResponse({ success: true, user });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case 'auth.logout':
        try {
          await auth.logout();
          sendResponse({ success: true });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case 'auth.status':
        try {
          const status = await auth.getAuthStatus();
          sendResponse({ success: true, ...status });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case 'auth.getToken':
        try {
          const token = await auth.getValidAccessToken();
          sendResponse({ success: !!token, token });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      // --- Cloud Chat (shared module) ---
      case 'chat.listModels':
        try {
          const token = await auth.getValidAccessToken();
          if (!token) { sendResponse({ success: false, error: 'Not authenticated' }); break; }
          const models = await listModels(token);
          sendResponse({ success: true, models });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case 'chat.complete':
        try {
          const token = await auth.getValidAccessToken();
          if (!token) { sendResponse({ success: false, error: 'Not authenticated' }); break; }
          const model = String(request.model || 'gpt-4o');
          const messagesInput = Array.isArray(request.messages) ? request.messages : [];
          const messages: ChatMessage[] = messagesInput
            .filter((m: any) => m && typeof m.content === 'string' && typeof m.role === 'string')
            .map((m: any) => ({
              role: (m.role === 'system' || m.role === 'assistant') ? m.role : 'user',
              content: String(m.content),
            }))
            .slice(-24);
          if (!messages.length) { sendResponse({ success: false, error: 'messages are required' }); break; }
          const content = await chatCompletion(token, {
            model, messages,
            temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
            max_tokens: typeof request.max_tokens === 'number' ? request.max_tokens : undefined,
          });
          sendResponse({ success: true, content });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      // --- ZAP Protocol (not available on Firefox — return proper status) ---
      case 'zap.status':
        sendResponse({ success: true, zap: { connected: false, mcps: [], extensionId: 'firefox' } });
        break;

      case 'zap.discover':
        sendResponse({ success: true, mcps: [] });
        break;

      case 'zap.listTools':
        sendResponse({ success: true, tools: [] });
        break;

      case 'zap.connect':
      case 'zap.callTool':
        sendResponse({ success: false, error: 'ZAP protocol not available on Firefox yet' });
        break;

      // --- Element selection (click-to-code) ---
      case 'elementSelected':
        if (hanzoExtension.isConnected()) {
          hanzoExtension.sendToWs({
            type: 'elementSelected',
            data: request.data,
          });
        }
        sendResponse({ success: true });
        break;

      // --- Tab Filesystem ---
      case 'listTabFS': {
        const allTabs = await browser.tabs.query({});
        sendResponse({
          success: true,
          tabs: allTabs.map(tab => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            active: tab.active,
          })),
        });
        break;
      }

      case 'readTabFS':
        sendResponse({ success: false, error: 'Tab filesystem read not available on Firefox' });
        break;

      case 'writeTabFS':
        sendResponse({ success: false, error: 'Tab filesystem write not available on Firefox' });
        break;

      // --- WebGPU / Local AI ---
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
            models: [],
          });
        } catch {
          sendResponse({ available: false });
        }
        break;
      }

      case 'runLocalAI':
        sendResponse({ success: false, error: 'Local AI not available on Firefox' });
        break;

      case 'listAgents':
        sendResponse({ success: true, agents: [] });
        break;

      case 'stopAgent':
        sendResponse({ success: false, error: 'Agent workers not available on Firefox' });
        break;

      case 'launchAIWorker':
        sendResponse({ success: false, error: 'AI workers not available on Firefox' });
        break;

      // --- RAG ---
      case 'rag.query': {
        try {
          const config = await getRagConfig();
          const topKInput = Number.parseInt(String(request.topK ?? config.topK), 10);
          const params = {
            endpoint: String(request.endpoint ?? config.endpoint ?? '').trim(),
            apiKey: String(request.apiKey ?? config.apiKey ?? '').trim(),
            query: String(request.query || '').trim(),
            topK: Number.isFinite(topKInput) ? Math.max(1, Math.min(topKInput, 20)) : 5,
            knowledgeBase: String(request.knowledgeBase ?? config.knowledgeBase ?? '').trim(),
            includeTabContext: request.includeTabContext !== undefined
              ? !!request.includeTabContext
              : config.includeTabContext,
            pageContext: request.pageContext && typeof request.pageContext === 'object'
              ? {
                  url: request.pageContext.url ? String(request.pageContext.url) : undefined,
                  title: request.pageContext.title ? String(request.pageContext.title) : undefined,
                }
              : undefined,
          };
          if (!params.query) { sendResponse({ success: false, error: 'Query is required' }); break; }
          if (!params.endpoint) { sendResponse({ success: true, source: 'none', snippets: [] }); break; }
          const snippets = await queryRagEndpoint(params);
          sendResponse({ success: true, source: snippets.length ? 'rag-endpoint' : 'none', snippets });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;
      }

      // --- Bridge status ---
      case 'bridge.status':
        sendResponse({
          success: true,
          connected: hanzoExtension.isConnected(),
          browsers: hanzoExtension.isConnected() ? ['firefox'] : [],
        });
        break;

      // --- Config ---
      case 'config.save':
        sendResponse({ success: true });
        break;

      // --- In-page overlay (forwarded to content script) ---
      case 'page.overlay.toggle':
      case 'page.overlay.show':
      case 'page.overlay.hide':
      case 'page.overlay.status': {
        try {
          const tabId = typeof request.tabId === 'number'
            ? request.tabId
            : (sender.tab?.id ?? await hanzoExtension.getActiveTabId());
          if (tabId === null) { sendResponse({ success: false, error: 'No target tab' }); break; }
          const response = await browser.tabs.sendMessage(tabId, { action: request.action }).catch(() => null);
          sendResponse({ success: true, tabId, ...(response || {}) });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;
      }

      // --- AI Control Overlay ---
      case 'ai.control.start':
      case 'ai.control.cursor':
      case 'ai.control.highlight':
      case 'ai.control.status': {
        const targetTabId = request.tabId || controlSession.tabId || await hanzoExtension.getActiveTabId();
        if (!targetTabId) {
          sendResponse({ success: false, error: 'No target tab found' });
          break;
        }
        if (request.action !== 'ai.control.start' && controlSession.active && controlSession.tabId && targetTabId !== controlSession.tabId) {
          sendResponse({ success: false, error: `Control locked to tab ${controlSession.tabId}` });
          break;
        }
        if (request.action === 'ai.control.start') {
          await hanzoExtension.startControlSession(targetTabId, request.task);
        } else {
          browser.tabs.sendMessage(targetTabId, request).catch(() => {});
        }
        sendResponse({ success: true, tabId: targetTabId });
        break;
      }

      case 'ai.control.stop':
      case 'ai.control.cancel':
        await hanzoExtension.stopControlSession();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: `Unknown action: ${request.action}` });
        break;
    }
  })();
  return true; // Keep channel open for async
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const hanzoExtension = new HanzoFirefoxExtension();

browser.tabs.onRemoved.addListener((tabId) => {
  if (controlSession.active && controlSession.tabId === tabId) {
    void hanzoExtension.stopControlSession();
  }
});

console.log('[Hanzo] Firefox background script loaded');
