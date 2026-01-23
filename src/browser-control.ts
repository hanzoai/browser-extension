// Browser Control API for AI agents
// Enables AI to control browser tabs and implement FUSE-like filesystem

interface TabFileSystem {
  path: string;
  tabId: number;
  url: string;
  title: string;
  content?: string;
}

export class BrowserControl {
  private tabFS: Map<string, TabFileSystem> = new Map();
  private aiWorkers: Map<number, Worker> = new Map();
  
  constructor() {
    this.initializeTabFileSystem();
    this.setupMessageHandlers();
  }
  
  private initializeTabFileSystem() {
    // Mount tabs as filesystem paths
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab, index) => {
          if (tab.id && tab.url) {
            const path = `/tabs/${index}/${this.sanitizePath(tab.title || 'untitled')}`;
            this.tabFS.set(path, {
              path,
              tabId: tab.id,
              url: tab.url,
              title: tab.title || 'Untitled'
            });
          }
        });
      });
      
      // Listen for tab updates
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete') {
          this.updateTabFS(tab);
        }
      });
    }
  }
  
  private sanitizePath(title: string): string {
    return title.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
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
      title: tab.title || 'Untitled'
    });
  }
  
  // FUSE-like filesystem operations
  async readTab(path: string): Promise<string> {
    const entry = this.tabFS.get(path);
    if (!entry) {
      throw new Error(`Tab not found: ${path}`);
    }
    
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(entry.tabId, {
        action: 'getContent'
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response?.content || '');
        }
      });
    });
  }
  
  async writeTab(path: string, content: string): Promise<void> {
    const entry = this.tabFS.get(path);
    if (!entry) {
      throw new Error(`Tab not found: ${path}`);
    }
    
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(entry.tabId, {
        action: 'setContent',
        content
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
  }
  
  async listTabs(): Promise<string[]> {
    return Array.from(this.tabFS.keys());
  }
  
  // AI Control APIs
  async launchAIWorker(tabId: number, modelName: string): Promise<void> {
    // Create a dedicated worker for this tab
    const worker = new Worker(new URL('./ai-worker.js', import.meta.url), {
      type: 'module'
    });
    
    worker.postMessage({
      type: 'init',
      tabId,
      modelName
    });
    
    worker.onmessage = (event) => {
      this.handleAIWorkerMessage(tabId, event.data);
    };
    
    this.aiWorkers.set(tabId, worker);
  }
  
  private handleAIWorkerMessage(tabId: number, data: any) {
    switch (data.type) {
      case 'click':
        this.performClick(tabId, data.selector);
        break;
      case 'type':
        this.performType(tabId, data.selector, data.text);
        break;
      case 'navigate':
        this.navigateTo(tabId, data.url);
        break;
      case 'screenshot':
        this.captureScreenshot(tabId).then(screenshot => {
          const worker = this.aiWorkers.get(tabId);
          worker?.postMessage({
            type: 'screenshot',
            data: screenshot
          });
        });
        break;
    }
  }
  
  private async performClick(tabId: number, selector: string) {
    chrome.tabs.sendMessage(tabId, {
      action: 'click',
      selector
    });
  }
  
  private async performType(tabId: number, selector: string, text: string) {
    chrome.tabs.sendMessage(tabId, {
      action: 'type',
      selector,
      text
    });
  }
  
  private async navigateTo(tabId: number, url: string) {
    chrome.tabs.update(tabId, { url });
  }
  
  private async captureScreenshot(tabId: number): Promise<string> {
    return new Promise((resolve) => {
      chrome.tabs.captureVisibleTab(null, {
        format: 'png',
        quality: 100
      }, (dataUrl) => {
        resolve(dataUrl);
      });
    });
  }
  
  // Cross-tab communication for parallel AI execution
  async broadcastToAI(message: any) {
    this.aiWorkers.forEach((worker, tabId) => {
      worker.postMessage({
        type: 'broadcast',
        message
      });
    });
  }
  
  // Setup message handlers for content script
  private setupMessageHandlers() {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.from === 'content' && sender.tab?.id) {
          this.handleContentMessage(sender.tab.id, request, sendResponse);
          return true; // Keep channel open for async response
        }
      });
    }
  }
  
  private handleContentMessage(
    tabId: number, 
    request: any, 
    sendResponse: (response: any) => void
  ) {
    const worker = this.aiWorkers.get(tabId);
    if (worker) {
      worker.postMessage({
        type: 'contentMessage',
        data: request
      });
      
      // Set up one-time listener for response
      const responseHandler = (event: MessageEvent) => {
        if (event.data.type === 'contentResponse') {
          sendResponse(event.data.response);
          worker.removeEventListener('message', responseHandler);
        }
      };
      
      worker.addEventListener('message', responseHandler);
    }
  }
}