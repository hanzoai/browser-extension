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

  private async executeMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Get active tab for most commands
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

      case 'Page.navigate': {
        if (activeTab?.id) {
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
          const results = await browser.tabs.executeScript(activeTab.id, {
            code: expression
          });
          return { result: { value: results[0] } };
        }
        throw new Error('No active tab');
      }

      case 'Page.captureScreenshot':
      case 'hanzo.screenshot': {
        const format = (params.format as string) || 'png';
        const dataUrl = await browser.tabs.captureVisibleTab(null, {
          format: format as 'png' | 'jpeg'
        });
        // Remove data URL prefix to return raw base64
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        return { data: base64 };
      }

      case 'hanzo.click': {
        if (activeTab?.id && params.selector) {
          const selector = this.escapeSelector(params.selector as string);
          await browser.tabs.executeScript(activeTab.id, {
            code: `document.querySelector('${selector}')?.click()`
          });
          return { success: true };
        }
        throw new Error('No active tab or selector');
      }

      case 'hanzo.fill': {
        if (activeTab?.id && params.selector) {
          const selector = this.escapeSelector(params.selector as string);
          const value = this.escapeValue((params.value as string) || '');
          await browser.tabs.executeScript(activeTab.id, {
            code: `
              var el = document.querySelector('${selector}');
              if (el) {
                el.value = '${value}';
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
              }
            `
          });
          return { success: true };
        }
        throw new Error('No active tab or selector');
      }

      case 'hanzo.type': {
        if (activeTab?.id && params.text) {
          const text = this.escapeValue(params.text as string);
          await browser.tabs.executeScript(activeTab.id, {
            code: `
              var el = document.activeElement;
              if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                el.value += '${text}';
                el.dispatchEvent(new Event('input', {bubbles: true}));
              }
            `
          });
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

// Initialize extension (no export - Firefox doesn't support ES modules in background)
const hanzoExtension = new HanzoFirefoxExtension();
console.log('[Hanzo] Firefox background script loaded');
