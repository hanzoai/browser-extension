/**
 * Firefox-specific Background Script for Hanzo Browser Extension
 *
 * This script connects to the CDP bridge server as a WebSocket CLIENT
 * and handles commands from hanzo-mcp to control the browser.
 *
 * Firefox differences from Chrome:
 * - Uses `browser.*` APIs (with Promises) instead of `chrome.*` (callbacks)
 * - Cannot use ES module exports at top level
 * - Cannot run WebSocket servers, only clients
 * - Uses `browser.tabs.executeScript` instead of `chrome.debugger`
 */

// Declare browser API for TypeScript
declare const browser: typeof chrome;

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

class HanzoFirefoxExtension {
  private wsConnection: WebSocket | null = null;
  private cdpPort: number = 9223;
  private reconnectTimeout: number = 3000;

  constructor() {
    console.log('[Hanzo] Firefox extension initializing...');
    this.connect();
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

    this.wsConnection.onerror = (error) => {
      console.error('[Hanzo] WebSocket error:', error);
    };

    this.wsConnection.onclose = () => {
      console.log('[Hanzo] Disconnected, reconnecting...');
      setTimeout(() => this.connect(), this.reconnectTimeout);
    };
  }

  private register(): void {
    this.send({
      type: 'register',
      role: 'cdp-provider',
      capabilities: [
        'navigate', 'screenshot', 'click', 'type', 'evaluate', 'tabs',
        'fill', 'reload', 'goBack', 'goForward'
      ]
    });
  }

  private send(data: unknown): void {
    if (this.wsConnection?.readyState === WebSocket.OPEN) {
      this.wsConnection.send(JSON.stringify(data));
    }
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

  /**
   * Wrap executeScript with a timeout to prevent blocking on GPU-heavy pages
   */
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
    // Get active tab for most commands (native API, never blocks)
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

      // Native tab property reads - never block on page content
      case 'hanzo.url': {
        if (activeTab) {
          return { result: { value: activeTab.url || '' } };
        }
        throw new Error('No active tab');
      }

      case 'hanzo.title': {
        if (activeTab) {
          return { result: { value: activeTab.title || '' } };
        }
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
          const results = await this.executeScriptWithTimeout(
            activeTab.id,
            expression,
            timeout
          );
          return { result: { value: results[0] } };
        }
        throw new Error('No active tab');
      }

      case 'Page.captureScreenshot':
      case 'hanzo.screenshot': {
        // Use jpeg by default for speed on GPU-heavy pages
        const format = (params.format as string) || 'jpeg';
        const quality = (params.quality as number) || (format === 'jpeg' ? 80 : undefined);
        const opts: any = { format: format as 'png' | 'jpeg' };
        if (quality !== undefined) opts.quality = quality;
        const dataUrl = await browser.tabs.captureVisibleTab(opts);
        // Remove data URL prefix to return raw base64
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
            `
          );
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
            `
          );
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

// =============================================================================
// Auth + Chat Message Handlers (Firefox)
// Uses browser.identity.launchWebAuthFlow for OAuth
// =============================================================================

const IAM_BASE = 'https://hanzo.id';
const API_BASE = 'https://api.hanzo.ai';
const CLIENT_ID = 'app-hanzo';
const SCOPES = 'openid profile email';

const STORAGE_KEYS = {
  accessToken: 'hanzo_iam_access_token',
  refreshToken: 'hanzo_iam_refresh_token',
  idToken: 'hanzo_iam_id_token',
  expiresAt: 'hanzo_iam_expires_at',
  user: 'hanzo_iam_user',
};

// PKCE helpers
function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, length);
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
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

async function firefoxLogin(): Promise<any> {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  const state = generateRandomString(32);
  const redirectUri = 'https://hanzo.ai/callback';

  const authorizeUrl = new URL(`${IAM_BASE}/login/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('state', state);

  // Tab-based auth: open a real browser tab for login
  const callbackUrl = await new Promise<string>((resolve, reject) => {
    let authTabId: number | undefined;
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Login timed out')); }, 300_000);

    function cleanup() {
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }
    function onUpdated(tabId: number, changeInfo: any) {
      if (tabId !== authTabId || !changeInfo.url) return;
      if (changeInfo.url.startsWith(redirectUri)) {
        cleanup();
        browser.tabs.remove(tabId).catch(() => {});
        resolve(changeInfo.url);
      }
    }
    function onRemoved(tabId: number) {
      if (tabId !== authTabId) return;
      cleanup();
      reject(new Error('Login cancelled'));
    }

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.create({ url: authorizeUrl.toString() }).then((tab: any) => {
      authTabId = tab.id;
    });
  });

  const url = new URL(callbackUrl);
  if (url.searchParams.get('state') !== state) throw new Error('State mismatch');
  const code = url.searchParams.get('code');
  if (!code) throw new Error(url.searchParams.get('error_description') || 'No code');

  const tokenResponse = await fetch(`${IAM_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID,
      code, redirect_uri: redirectUri, code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
  const tokens = await tokenResponse.json();

  const data: any = { [STORAGE_KEYS.accessToken]: tokens.access_token };
  if (tokens.refresh_token) data[STORAGE_KEYS.refreshToken] = tokens.refresh_token;
  if (tokens.id_token) data[STORAGE_KEYS.idToken] = tokens.id_token;
  if (tokens.expires_in) data[STORAGE_KEYS.expiresAt] = Date.now() + tokens.expires_in * 1000;
  await browser.storage.local.set(data);

  const userResp = await fetch(`${IAM_BASE}/oauth/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const user = userResp.ok ? await userResp.json() : {};
  await browser.storage.local.set({ [STORAGE_KEYS.user]: user });
  return user;
}

browser.runtime.onMessage.addListener((request: any, sender: any, sendResponse: Function) => {
  (async () => {
    switch (request.action) {
      case 'auth.login':
        try {
          const user = await firefoxLogin();
          sendResponse({ success: true, user });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case 'auth.logout':
        await browser.storage.local.remove(Object.values(STORAGE_KEYS));
        sendResponse({ success: true });
        break;

      case 'auth.status': {
        const result = await browser.storage.local.get([STORAGE_KEYS.accessToken, STORAGE_KEYS.user]);
        sendResponse({
          success: true,
          authenticated: !!result[STORAGE_KEYS.accessToken],
          user: result[STORAGE_KEYS.user] || null,
        });
        break;
      }

      case 'auth.getToken': {
        const r = await browser.storage.local.get([STORAGE_KEYS.accessToken]);
        sendResponse({ success: !!r[STORAGE_KEYS.accessToken], token: r[STORAGE_KEYS.accessToken] || null });
        break;
      }

      case 'chat.listModels': {
        const t = await browser.storage.local.get([STORAGE_KEYS.accessToken]);
        if (!t[STORAGE_KEYS.accessToken]) { sendResponse({ success: false, error: 'Not authenticated' }); break; }
        const resp = await fetch(`${API_BASE}/v1/models`, { headers: { Authorization: `Bearer ${t[STORAGE_KEYS.accessToken]}` } });
        const data = await resp.json();
        sendResponse({ success: true, models: data.data || data.models || data || [] });
        break;
      }

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

      case 'listAgents':
        sendResponse({ success: true, agents: [] });
        break;

      case 'stopAgent':
        sendResponse({ success: false, error: 'Agent workers are not available in Firefox background mode yet' });
        break;

      case 'launchAIWorker':
        sendResponse({ success: false, error: 'launchAIWorker is not implemented in Firefox background mode yet' });
        break;

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

          if (!params.query) {
            sendResponse({ success: false, error: 'Query is required' });
            break;
          }

          if (!params.endpoint) {
            sendResponse({ success: true, source: 'none', snippets: [] });
            break;
          }

          const snippets = await queryRagEndpoint(params);
          sendResponse({ success: true, source: snippets.length ? 'rag-endpoint' : 'none', snippets });
        } catch (e: any) {
          sendResponse({ success: false, error: e.message });
        }
        break;
      }

      // --- AI Control Overlay (forwarded to content script) ---
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
        await hanzoExtension.stopControlSession();
        sendResponse({ success: true });
        break;

      case 'ai.control.cancel':
        // User clicked Stop — end local control session
        await hanzoExtension.stopControlSession();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: `Unknown action: ${request.action}` });
        break;
    }
  })();
  return true; // Keep channel open
});

// Initialize extension (no export - Firefox doesn't support ES modules in background)
const hanzoExtension = new HanzoFirefoxExtension();

// End active session when the controlled tab closes.
browser.tabs.onRemoved.addListener((tabId) => {
  if (controlSession.active && controlSession.tabId === tabId) {
    void hanzoExtension.stopControlSession();
  }
});

console.log('[Hanzo] Firefox background script loaded');
