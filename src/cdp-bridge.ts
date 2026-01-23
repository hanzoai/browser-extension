// CDP Bridge for hanzo-mcp Browser Tool Integration
// Enables Playwright to control browser via Chrome DevTools Protocol

interface CDPSession {
  tabId: number;
  debuggee: chrome.debugger.Debuggee;
  connected: boolean;
}

interface CDPCommand {
  id: number;
  method: string;
  params?: any;
  tabId?: number;
}

interface CDPResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

export class CDPBridge {
  private sessions: Map<number, CDPSession> = new Map();
  private messageHandlers: Map<number, (response: CDPResponse) => void> = new Map();
  private commandId: number = 0;
  private wsServer: WebSocket | null = null;
  private wsClients: Set<WebSocket> = new Set();
  
  constructor() {
    this.setupDebuggerListener();
  }
  
  private setupDebuggerListener() {
    // Listen for CDP events from attached debuggers
    if (typeof chrome !== 'undefined' && chrome.debugger) {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        this.broadcastEvent(source.tabId!, method, params);
      });
      
      chrome.debugger.onDetach.addListener((source, reason) => {
        console.log(`[CDP] Detached from tab ${source.tabId}: ${reason}`);
        if (source.tabId) {
          this.sessions.delete(source.tabId);
        }
      });
    }
  }
  
  // Attach debugger to a tab
  async attach(tabId: number): Promise<boolean> {
    if (this.sessions.has(tabId)) {
      return true; // Already attached
    }
    
    return new Promise((resolve) => {
      const debuggee: chrome.debugger.Debuggee = { tabId };
      
      chrome.debugger.attach(debuggee, '1.3', () => {
        if (chrome.runtime.lastError) {
          console.error(`[CDP] Failed to attach: ${chrome.runtime.lastError.message}`);
          resolve(false);
        } else {
          this.sessions.set(tabId, {
            tabId,
            debuggee,
            connected: true
          });
          console.log(`[CDP] Attached to tab ${tabId}`);
          resolve(true);
        }
      });
    });
  }
  
  // Detach from a tab
  async detach(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    
    return new Promise((resolve) => {
      chrome.debugger.detach(session.debuggee, () => {
        this.sessions.delete(tabId);
        resolve();
      });
    });
  }
  
  // Send CDP command
  async send(tabId: number, method: string, params?: any): Promise<any> {
    const session = this.sessions.get(tabId);
    if (!session) {
      // Auto-attach if not attached
      const attached = await this.attach(tabId);
      if (!attached) {
        throw new Error(`Cannot attach to tab ${tabId}`);
      }
    }
    
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId },
        method,
        params || {},
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        }
      );
    });
  }
  
  // High-level browser control methods for hanzo-mcp integration
  
  async navigate(tabId: number, url: string): Promise<void> {
    await this.send(tabId, 'Page.navigate', { url });
  }
  
  async screenshot(tabId: number, options?: {
    format?: 'jpeg' | 'png' | 'webp';
    quality?: number;
    clip?: { x: number; y: number; width: number; height: number };
    fullPage?: boolean;
  }): Promise<string> {
    // Enable Page domain first
    await this.send(tabId, 'Page.enable');
    
    const params: any = {
      format: options?.format || 'png',
    };
    
    if (options?.quality) {
      params.quality = options.quality;
    }
    
    if (options?.fullPage) {
      // Get full page metrics
      const metrics = await this.send(tabId, 'Page.getLayoutMetrics');
      params.clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1
      };
      params.captureBeyondViewport = true;
    } else if (options?.clip) {
      params.clip = { ...options.clip, scale: 1 };
    }
    
    const result = await this.send(tabId, 'Page.captureScreenshot', params);
    return result.data; // Base64 encoded
  }
  
  async click(tabId: number, x: number, y: number): Promise<void> {
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
  }
  
  async type(tabId: number, text: string): Promise<void> {
    for (const char of text) {
      await this.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char
      });
      await this.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char
      });
    }
  }
  
  async evaluate(tabId: number, expression: string): Promise<any> {
    await this.send(tabId, 'Runtime.enable');
    const result = await this.send(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true
    });
    return result.result?.value;
  }
  
  async getDocument(tabId: number): Promise<any> {
    await this.send(tabId, 'DOM.enable');
    return this.send(tabId, 'DOM.getDocument');
  }
  
  async querySelector(tabId: number, selector: string): Promise<number | null> {
    const doc = await this.getDocument(tabId);
    try {
      const result = await this.send(tabId, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector
      });
      return result.nodeId || null;
    } catch {
      return null;
    }
  }
  
  async getBoxModel(tabId: number, nodeId: number): Promise<any> {
    return this.send(tabId, 'DOM.getBoxModel', { nodeId });
  }
  
  async clickSelector(tabId: number, selector: string): Promise<boolean> {
    const nodeId = await this.querySelector(tabId, selector);
    if (!nodeId) {
      return false;
    }
    
    const box = await this.getBoxModel(tabId, nodeId);
    if (!box?.model?.content) {
      return false;
    }
    
    // Get center of element
    const quad = box.model.content;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    
    await this.click(tabId, x, y);
    return true;
  }
  
  async fillSelector(tabId: number, selector: string, value: string): Promise<boolean> {
    // Focus the element
    const nodeId = await this.querySelector(tabId, selector);
    if (!nodeId) {
      return false;
    }
    
    await this.send(tabId, 'DOM.focus', { nodeId });
    
    // Clear existing content
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      modifiers: 2 // Ctrl/Cmd
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      modifiers: 2
    });
    
    // Type new value
    await this.type(tabId, value);
    return true;
  }
  
  // WebSocket server for external connections (hanzo-mcp)
  startWebSocketServer(port: number = 9223): void {
    // Note: Chrome extensions can't create native WebSocket servers
    // Instead, we connect to an external bridge server
    this.connectToBridge(`ws://localhost:${port}/cdp`);
  }
  
  private connectToBridge(url: string): void {
    try {
      this.wsServer = new WebSocket(url);
      
      this.wsServer.onopen = () => {
        console.log('[CDP] Connected to bridge server');
        // Register as CDP provider
        this.wsServer?.send(JSON.stringify({
          type: 'register',
          role: 'cdp-provider',
          capabilities: ['navigate', 'screenshot', 'click', 'type', 'evaluate']
        }));
      };
      
      this.wsServer.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          const response = await this.handleBridgeMessage(message);
          this.wsServer?.send(JSON.stringify(response));
        } catch (error: any) {
          this.wsServer?.send(JSON.stringify({
            id: 0,
            error: { code: -32603, message: error.message }
          }));
        }
      };
      
      this.wsServer.onerror = (error) => {
        console.error('[CDP] Bridge connection error:', error);
      };
      
      this.wsServer.onclose = () => {
        console.log('[CDP] Bridge disconnected, reconnecting in 5s...');
        setTimeout(() => this.connectToBridge(url), 5000);
      };
    } catch (error) {
      console.error('[CDP] Failed to connect to bridge:', error);
      setTimeout(() => this.connectToBridge(url), 5000);
    }
  }
  
  private async handleBridgeMessage(message: any): Promise<CDPResponse> {
    const { id, method, params } = message;
    
    try {
      let result: any;
      
      // Get active tab if not specified
      const tabId = params?.tabId || await this.getActiveTabId();
      
      switch (method) {
        case 'Browser.getVersion':
          result = {
            protocolVersion: '1.3',
            product: 'Hanzo Browser Extension',
            userAgent: navigator.userAgent
          };
          break;
          
        case 'Target.getTargets':
          result = await this.getTargets();
          break;
          
        case 'Page.navigate':
          await this.navigate(tabId, params.url);
          result = { frameId: 'main' };
          break;
          
        case 'Page.captureScreenshot':
          const screenshot = await this.screenshot(tabId, params);
          result = { data: screenshot };
          break;
          
        case 'Input.dispatchMouseEvent':
          await this.send(tabId, method, params);
          result = {};
          break;
          
        case 'Input.dispatchKeyEvent':
          await this.send(tabId, method, params);
          result = {};
          break;
          
        case 'Runtime.evaluate':
          result = await this.send(tabId, method, params);
          break;
          
        case 'DOM.getDocument':
          result = await this.getDocument(tabId);
          break;
          
        case 'DOM.querySelector':
          const nodeId = await this.querySelector(tabId, params.selector);
          result = { nodeId };
          break;
          
        // High-level commands for hanzo-mcp
        case 'hanzo.click':
          const clicked = await this.clickSelector(tabId, params.selector);
          result = { success: clicked };
          break;
          
        case 'hanzo.fill':
          const filled = await this.fillSelector(tabId, params.selector, params.value);
          result = { success: filled };
          break;
          
        case 'hanzo.screenshot':
          const screenshotData = await this.screenshot(tabId, params);
          result = { data: screenshotData };
          break;
          
        default:
          // Pass through to Chrome debugger
          result = await this.send(tabId, method, params);
      }
      
      return { id, result };
    } catch (error: any) {
      return {
        id,
        error: { code: -32603, message: error.message }
      };
    }
  }
  
  private async getActiveTabId(): Promise<number> {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          resolve(tabs[0].id);
        } else {
          reject(new Error('No active tab'));
        }
      });
    });
  }
  
  private async getTargets(): Promise<{ targetInfos: any[] }> {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const targetInfos = tabs.map(tab => ({
          targetId: `tab-${tab.id}`,
          type: 'page',
          title: tab.title,
          url: tab.url,
          attached: this.sessions.has(tab.id!),
          browserContextId: 'default'
        }));
        resolve({ targetInfos });
      });
    });
  }
  
  private broadcastEvent(tabId: number, method: string, params: any): void {
    const event = JSON.stringify({
      type: 'event',
      tabId,
      method,
      params
    });
    
    if (this.wsServer?.readyState === WebSocket.OPEN) {
      this.wsServer.send(event);
    }
  }
}

// Singleton instance
let cdpBridgeInstance: CDPBridge | null = null;

export function getCDPBridge(): CDPBridge {
  if (!cdpBridgeInstance) {
    cdpBridgeInstance = new CDPBridge();
  }
  return cdpBridgeInstance;
}
