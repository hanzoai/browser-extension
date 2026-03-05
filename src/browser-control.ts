// Browser Control API for AI agents
// Full native browser control: click, type, fill, navigate, screenshot, scroll,
// select, hover, wait, evaluate, keyboard events, drag, tab filesystem, and AI workers.

interface TabFileSystem {
  path: string;
  tabId: number;
  url: string;
  title: string;
  content?: string;
}

interface AgentInfo {
  id: string;
  name: string;
  tabId: number;
  status: 'running' | 'stopped' | 'error';
  worker: Worker;
}

export class BrowserControl {
  private tabFS: Map<string, TabFileSystem> = new Map();
  private aiWorkers: Map<number, Worker> = new Map();
  private agents: Map<string, AgentInfo> = new Map();

  constructor() {
    this.initializeTabFileSystem();
    this.setupMessageHandlers();
  }

  private initializeTabFileSystem() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab, index) => {
        if (tab.id && tab.url) {
          const path = `/tabs/${index}/${this.sanitizePath(tab.title || 'untitled')}`;
          this.tabFS.set(path, {
            path,
            tabId: tab.id,
            url: tab.url,
            title: tab.title || 'Untitled',
          });
        }
      });
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete') {
        this.updateTabFS(tab);
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      for (const [path, entry] of this.tabFS) {
        if (entry.tabId === tabId) {
          this.tabFS.delete(path);
          break;
        }
      }
    });
  }

  private sanitizePath(title: string): string {
    return title.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase().substring(0, 60);
  }

  private updateTabFS(tab: chrome.tabs.Tab) {
    if (!tab.id || !tab.url) return;

    const existingEntry = Array.from(this.tabFS.values()).find(
      entry => entry.tabId === tab.id
    );

    const path = existingEntry?.path ||
      `/tabs/${this.tabFS.size}/${this.sanitizePath(tab.title || 'untitled')}`;

    this.tabFS.set(path, {
      path,
      tabId: tab.id,
      url: tab.url,
      title: tab.title || 'Untitled',
    });
  }

  // ===========================================================================
  // FUSE-like Tab Filesystem
  // ===========================================================================

  async readTab(path: string): Promise<string> {
    const entry = this.tabFS.get(path);
    if (!entry) throw new Error(`Tab not found: ${path}`);

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(entry.tabId, { action: 'getContent' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response?.content || '');
        }
      });
    });
  }

  async writeTab(path: string, content: string): Promise<void> {
    const entry = this.tabFS.get(path);
    if (!entry) throw new Error(`Tab not found: ${path}`);

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(entry.tabId, { action: 'setContent', content }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  async listTabs(): Promise<string[]> {
    return Array.from(this.tabFS.keys());
  }

  // ===========================================================================
  // Native Browser Actions
  // ===========================================================================

  async click(tabId: number, selector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
        return true;
      })()
    `);
  }

  async clickAtPoint(tabId: number, x: number, y: number): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${x}, clientY: ${y} }));
        return true;
      })()
    `);
  }

  async doubleClick(tabId: number, selector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()
    `);
  }

  async type(tabId: number, selector: string, text: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        for (const char of ${JSON.stringify(text)}) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
          if ('value' in el) el.value += char;
          el.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
  }

  async fill(tabId: number, selector: string, value: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el), 'value'
        )?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, ${JSON.stringify(value)});
        } else {
          el.value = ${JSON.stringify(value)};
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
  }

  async select(tabId: number, selector: string, value: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
  }

  async check(tabId: number, selector: string, checked: boolean): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (el.checked !== ${checked}) el.click();
        return true;
      })()
    `);
  }

  async hover(tabId: number, selector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return true;
      })()
    `);
  }

  async focus(tabId: number, selector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()
    `);
  }

  async blur(tabId: number, selector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.blur();
        return true;
      })()
    `);
  }

  async scroll(tabId: number, x: number, y: number, selector?: string): Promise<boolean> {
    if (selector) {
      return this.executeScript(tabId, `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.scrollBy({ left: ${x}, top: ${y}, behavior: 'smooth' });
          return true;
        })()
      `);
    }
    return this.executeScript(tabId, `
      (() => { window.scrollBy({ left: ${x}, top: ${y}, behavior: 'smooth' }); return true; })()
    `);
  }

  async scrollIntoView(tabId: number, selector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return true;
      })()
    `);
  }

  async pressKey(tabId: number, key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const opts = {
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(key)},
          bubbles: true,
          ctrlKey: ${!!modifiers.ctrl},
          shiftKey: ${!!modifiers.shift},
          altKey: ${!!modifiers.alt},
          metaKey: ${!!modifiers.meta},
        };
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', opts));
        document.activeElement.dispatchEvent(new KeyboardEvent('keypress', opts));
        document.activeElement.dispatchEvent(new KeyboardEvent('keyup', opts));
        return true;
      })()
    `);
  }

  async drag(tabId: number, fromSelector: string, toSelector: string): Promise<boolean> {
    return this.executeScript(tabId, `
      (() => {
        const from = document.querySelector(${JSON.stringify(fromSelector)});
        const to = document.querySelector(${JSON.stringify(toSelector)});
        if (!from || !to) return false;
        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();
        const fromX = fromRect.left + fromRect.width / 2;
        const fromY = fromRect.top + fromRect.height / 2;
        const toX = toRect.left + toRect.width / 2;
        const toY = toRect.top + toRect.height / 2;
        from.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: fromX, clientY: fromY }));
        from.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: toX, clientY: toY }));
        to.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: toX, clientY: toY }));
        to.dispatchEvent(new DragEvent('drop', { bubbles: true }));
        return true;
      })()
    `);
  }

  async waitForSelector(tabId: number, selector: string, timeoutMs: number = 10000): Promise<boolean> {
    return this.executeScript(tabId, `
      new Promise((resolve) => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) { resolve(true); return; }
        const observer = new MutationObserver(() => {
          if (document.querySelector(${JSON.stringify(selector)})) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(false); }, ${timeoutMs});
      })
    `);
  }

  async waitForNavigation(tabId: number, timeoutMs: number = 30000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, timeoutMs);

      const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async evaluate(tabId: number, expression: string): Promise<any> {
    return this.executeScript(tabId, expression);
  }

  async getElementInfo(tabId: number, selector: string): Promise<any> {
    return this.executeScript(tabId, `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const styles = window.getComputedStyle(el);
        return {
          tagName: el.tagName.toLowerCase(),
          id: el.id,
          className: el.className,
          textContent: el.textContent?.substring(0, 500),
          innerText: el.innerText?.substring(0, 500),
          value: el.value,
          href: el.href,
          src: el.src,
          type: el.type,
          checked: el.checked,
          disabled: el.disabled,
          visible: styles.display !== 'none' && styles.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
        };
      })()
    `);
  }

  async getPageInfo(tabId: number): Promise<any> {
    return this.executeScript(tabId, `
      (() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        forms: document.forms.length,
        links: document.links.length,
        images: document.images.length,
      }))()
    `);
  }

  async querySelectorAll(tabId: number, selector: string): Promise<any[]> {
    return this.executeScript(tabId, `
      (() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, 100).map((el, i) => ({
        index: i,
        tagName: el.tagName.toLowerCase(),
        id: el.id,
        className: el.className,
        textContent: el.textContent?.substring(0, 200),
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
      })))()
    `);
  }

  // ===========================================================================
  // Navigation
  // ===========================================================================

  async navigateTo(tabId: number, url: string): Promise<void> {
    chrome.tabs.update(tabId, { url });
  }

  async reload(tabId: number): Promise<void> {
    chrome.tabs.reload(tabId);
  }

  async goBack(tabId: number): Promise<void> {
    chrome.tabs.goBack(tabId);
  }

  async goForward(tabId: number): Promise<void> {
    chrome.tabs.goForward(tabId);
  }

  async createTab(url: string, active: boolean = true): Promise<number> {
    return new Promise((resolve) => {
      chrome.tabs.create({ url, active }, (tab) => {
        resolve(tab.id!);
      });
    });
  }

  async closeTab(tabId: number): Promise<void> {
    chrome.tabs.remove(tabId);
  }

  // ===========================================================================
  // Screenshots
  // ===========================================================================

  async captureScreenshot(tabId?: number, options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      const format = options?.format || 'jpeg';
      const quality = options?.quality || (format === 'jpeg' ? 80 : undefined);
      const captureOpts: chrome.tabs.CaptureVisibleTabOptions = { format };
      if (quality !== undefined) captureOpts.quality = quality;

      chrome.tabs.captureVisibleTab(captureOpts, (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(dataUrl);
        }
      });
    });
  }

  async captureFullPage(tabId: number): Promise<string> {
    // Capture full page by scrolling and stitching
    const pageInfo = await this.getPageInfo(tabId);
    // For simplicity, capture visible viewport — full-page stitching requires
    // CDP which is handled by cdp-bridge-server.ts
    return this.captureScreenshot(tabId, { format: 'png' });
  }

  // ===========================================================================
  // AI Worker Management
  // ===========================================================================

  async launchAIWorker(tabId: number, modelName: string): Promise<string> {
    const worker = new Worker(new URL('./ai-worker.js', import.meta.url), {
      type: 'module',
    });

    const agentId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;

    worker.postMessage({ type: 'init', payload: { tabId, modelName } });

    worker.onmessage = (event) => {
      this.handleAIWorkerMessage(tabId, agentId, event.data);
    };

    worker.onerror = (event) => {
      console.error(`[Hanzo] AI worker error for tab ${tabId}:`, event.message);
      const agent = this.agents.get(agentId);
      if (agent) agent.status = 'error';
    };

    this.aiWorkers.set(tabId, worker);
    this.agents.set(agentId, {
      id: agentId,
      name: modelName,
      tabId,
      status: 'running',
      worker,
    });

    return agentId;
  }

  stopAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.worker.terminate();
    agent.status = 'stopped';
    this.aiWorkers.delete(agent.tabId);
    this.agents.delete(agentId);
    return true;
  }

  getAgents(): Array<{ id: string; name: string; tabId: number; status: string }> {
    return Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      tabId: a.tabId,
      status: a.status,
    }));
  }

  private handleAIWorkerMessage(tabId: number, agentId: string, data: any) {
    switch (data.type) {
      case 'click':
        this.click(tabId, data.selector);
        break;
      case 'type':
        this.type(tabId, data.selector, data.text);
        break;
      case 'fill':
        this.fill(tabId, data.selector, data.value);
        break;
      case 'navigate':
        this.navigateTo(tabId, data.url);
        break;
      case 'scroll':
        this.scroll(tabId, data.x || 0, data.y || 0, data.selector);
        break;
      case 'hover':
        this.hover(tabId, data.selector);
        break;
      case 'select':
        this.select(tabId, data.selector, data.value);
        break;
      case 'pressKey':
        this.pressKey(tabId, data.key, data.modifiers);
        break;
      case 'waitForSelector':
        this.waitForSelector(tabId, data.selector, data.timeout).then(found => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({ type: 'waitResult', found });
        });
        break;
      case 'evaluate':
        this.evaluate(tabId, data.expression).then(result => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({ type: 'evalResult', result });
        });
        break;
      case 'screenshot':
        this.captureScreenshot(tabId).then(screenshot => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({ type: 'screenshot', data: screenshot });
        });
        break;
      case 'getElementInfo':
        this.getElementInfo(tabId, data.selector).then(info => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({ type: 'elementInfo', info });
        });
        break;
      case 'getPageInfo':
        this.getPageInfo(tabId).then(info => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({ type: 'pageInfo', info });
        });
        break;
      case 'querySelectorAll':
        this.querySelectorAll(tabId, data.selector).then(elements => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({ type: 'elements', elements });
        });
        break;
      case 'done':
      case 'complete': {
        const agent = this.agents.get(agentId);
        if (agent) {
          agent.status = 'stopped';
          agent.worker.terminate();
          this.aiWorkers.delete(tabId);
          this.agents.delete(agentId);
        }
        break;
      }
    }
  }

  // ===========================================================================
  // Cross-tab Communication
  // ===========================================================================

  async broadcastToAI(message: any) {
    this.aiWorkers.forEach((worker) => {
      worker.postMessage({ type: 'broadcast', message });
    });
  }

  // ===========================================================================
  // Content Script Message Handler
  // ===========================================================================

  private setupMessageHandlers() {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.from === 'content' && sender.tab?.id) {
        this.handleContentMessage(sender.tab.id, request, sendResponse);
        return true;
      }

      // Handle browser control actions from popup/sidebar
      if (request.action?.startsWith('browser.')) {
        this.handleBrowserAction(request, sendResponse);
        return true;
      }

      // Agent management
      if (request.action === 'listAgents') {
        sendResponse({ success: true, agents: this.getAgents() });
        return true;
      }
      if (request.action === 'stopAgent') {
        const stopped = this.stopAgent(request.agentId);
        sendResponse({ success: stopped });
        return true;
      }
      if (request.action === 'checkWebGPU') {
        // Respond with GPU availability check
        if (navigator.gpu) {
          navigator.gpu.requestAdapter().then(adapter => {
            sendResponse({
              available: !!adapter,
              adapter: (adapter as any)?.name || 'Unknown GPU',
            });
          }).catch(() => {
            sendResponse({ available: false });
          });
        } else {
          sendResponse({ available: false });
        }
        return true;
      }
    });
  }

  private async handleBrowserAction(request: any, sendResponse: (response: any) => void) {
    const tabId = request.tabId;
    try {
      switch (request.action) {
        case 'browser.click':
          sendResponse({ success: await this.click(tabId, request.selector) });
          break;
        case 'browser.type':
          sendResponse({ success: await this.type(tabId, request.selector, request.text) });
          break;
        case 'browser.fill':
          sendResponse({ success: await this.fill(tabId, request.selector, request.value) });
          break;
        case 'browser.select':
          sendResponse({ success: await this.select(tabId, request.selector, request.value) });
          break;
        case 'browser.scroll':
          sendResponse({ success: await this.scroll(tabId, request.x, request.y, request.selector) });
          break;
        case 'browser.hover':
          sendResponse({ success: await this.hover(tabId, request.selector) });
          break;
        case 'browser.pressKey':
          sendResponse({ success: await this.pressKey(tabId, request.key, request.modifiers) });
          break;
        case 'browser.evaluate':
          sendResponse({ success: true, result: await this.evaluate(tabId, request.expression) });
          break;
        case 'browser.screenshot':
          sendResponse({ success: true, data: await this.captureScreenshot(tabId, request.options) });
          break;
        case 'browser.navigate':
          await this.navigateTo(tabId, request.url);
          sendResponse({ success: true });
          break;
        case 'browser.waitForSelector':
          sendResponse({ success: await this.waitForSelector(tabId, request.selector, request.timeout) });
          break;
        case 'browser.getElementInfo':
          sendResponse({ success: true, info: await this.getElementInfo(tabId, request.selector) });
          break;
        case 'browser.getPageInfo':
          sendResponse({ success: true, info: await this.getPageInfo(tabId) });
          break;
        case 'browser.querySelectorAll':
          sendResponse({ success: true, elements: await this.querySelectorAll(tabId, request.selector) });
          break;
        default:
          sendResponse({ success: false, error: `Unknown action: ${request.action}` });
      }
    } catch (e: any) {
      sendResponse({ success: false, error: e.message });
    }
  }

  private handleContentMessage(
    tabId: number,
    request: any,
    sendResponse: (response: any) => void
  ) {
    const worker = this.aiWorkers.get(tabId);
    if (worker) {
      worker.postMessage({ type: 'contentMessage', data: request });

      const responseHandler = (event: MessageEvent) => {
        if (event.data.type === 'contentResponse') {
          sendResponse(event.data.response);
          worker.removeEventListener('message', responseHandler);
        }
      };
      worker.addEventListener('message', responseHandler);

      // Timeout for content responses
      setTimeout(() => {
        worker.removeEventListener('message', responseHandler);
      }, 10000);
    } else {
      sendResponse({ error: 'No AI worker for this tab' });
    }
  }

  // ===========================================================================
  // Script Execution Helper
  // ===========================================================================

  private executeScript<T = any>(tabId: number, code: string): Promise<T> {
    return new Promise((resolve, reject) => {
      if (chrome.scripting) {
        // MV3: use chrome.scripting.executeScript
        chrome.scripting.executeScript({
          target: { tabId },
          func: new Function(`return (${code})`) as () => T,
        }, (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(results?.[0]?.result as T);
          }
        });
      } else {
        // MV2 fallback: use chrome.tabs.executeScript
        (chrome.tabs as any).executeScript(tabId, { code }, (results: any[]) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(results?.[0] as T);
          }
        });
      }
    });
  }
}
