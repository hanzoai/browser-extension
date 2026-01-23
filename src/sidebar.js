// Hanzo AI Browser Extension Sidebar Script

class HanzoSidebar {
  constructor() {
    this.authToken = null;
    this.user = null;
    this.mcpConnection = null;
    this.agents = new Map();
    this.processes = new Map();
    
    this.initializeUI();
    this.setupEventListeners();
    this.checkAuthStatus();
    this.connectToMCP();
    this.startMonitoring();
  }

  initializeUI() {
    // Get DOM elements
    this.elements = {
      authSection: document.getElementById('auth-section'),
      authStatus: document.getElementById('auth-status'),
      authBtn: document.getElementById('auth-btn'),
      mainContent: document.getElementById('main-content'),
      userAvatar: document.getElementById('user-avatar'),
      userName: document.getElementById('user-name'),
      userEmail: document.getElementById('user-email'),
      logoutBtn: document.getElementById('logout-btn'),
      
      mcpStatus: document.getElementById('mcp-status'),
      mcpTools: document.getElementById('mcp-tools'),
      
      agentCount: document.getElementById('agent-count'),
      agentList: document.getElementById('agent-list'),
      
      tabFs: document.getElementById('tab-fs'),
      refreshTabs: document.getElementById('refresh-tabs'),
      
      gpuStatus: document.getElementById('gpu-status'),
      gpuModel: document.getElementById('gpu-model'),
      gpuMemory: document.getElementById('gpu-memory'),
      
      processCount: document.getElementById('process-count'),
      processList: document.getElementById('process-list'),
      
      launchAgent: document.getElementById('launch-agent'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsPanel: document.getElementById('settings-panel'),
      closeSettings: document.getElementById('close-settings'),
      saveSettings: document.getElementById('save-settings')
    };
  }

  setupEventListeners() {
    // Auth
    this.elements.authBtn.addEventListener('click', () => this.authenticate());
    this.elements.logoutBtn.addEventListener('click', () => this.logout());
    
    // Actions
    this.elements.launchAgent.addEventListener('click', () => this.showAgentLauncher());
    this.elements.refreshTabs.addEventListener('click', () => this.refreshTabFilesystem());
    
    // Settings
    this.elements.settingsBtn.addEventListener('click', () => this.showSettings());
    this.elements.closeSettings.addEventListener('click', () => this.hideSettings());
    this.elements.saveSettings.addEventListener('click', () => this.saveSettings());
    
    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request, sender, sendResponse);
      return true;
    });
  }

  async checkAuthStatus() {
    try {
      const { authToken, user } = await chrome.storage.local.get(['authToken', 'user']);
      
      if (authToken && user) {
        this.authToken = authToken;
        this.user = user;
        this.showAuthenticated();
      }
    } catch (error) {
      console.error('Error checking auth status:', error);
    }
  }

  async authenticate() {
    this.elements.authBtn.disabled = true;
    this.elements.authBtn.textContent = 'Connecting...';
    
    try {
      // Open IAM login in new tab
      const authUrl = 'https://iam.hanzo.ai/auth/browser-extension';
      const authTab = await chrome.tabs.create({ url: authUrl });
      
      // Listen for auth callback
      const authListener = (tabId, changeInfo, tab) => {
        if (tabId === authTab.id && changeInfo.url) {
          const url = new URL(changeInfo.url);
          
          if (url.hostname === 'localhost' && url.searchParams.has('token')) {
            const token = url.searchParams.get('token');
            const user = {
              id: url.searchParams.get('user_id'),
              name: url.searchParams.get('name'),
              email: url.searchParams.get('email'),
              avatar: url.searchParams.get('avatar')
            };
            
            // Store auth data
            chrome.storage.local.set({ authToken: token, user });
            
            // Update UI
            this.authToken = token;
            this.user = user;
            this.showAuthenticated();
            
            // Close auth tab
            chrome.tabs.remove(tabId);
            chrome.tabs.onUpdated.removeListener(authListener);
          }
        }
      };
      
      chrome.tabs.onUpdated.addListener(authListener);
      
    } catch (error) {
      console.error('Authentication error:', error);
      this.showError('Failed to authenticate');
    } finally {
      this.elements.authBtn.disabled = false;
      this.elements.authBtn.textContent = 'Connect to Hanzo IAM';
    }
  }

  showAuthenticated() {
    // Update auth status
    this.elements.authStatus.innerHTML = `
      <div class="status-indicator connected"></div>
      <span>Connected</span>
    `;
    
    // Show user info
    if (this.user) {
      this.elements.userAvatar.src = this.user.avatar || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="%23FF6B6B"/></svg>';
      this.elements.userName.textContent = this.user.name || 'User';
      this.elements.userEmail.textContent = this.user.email || '';
    }
    
    // Show main content
    this.elements.authSection.style.display = 'none';
    this.elements.mainContent.classList.remove('hidden');
  }

  async logout() {
    await chrome.storage.local.remove(['authToken', 'user']);
    this.authToken = null;
    this.user = null;
    
    // Reset UI
    this.elements.authSection.style.display = 'flex';
    this.elements.mainContent.classList.add('hidden');
    this.elements.authStatus.innerHTML = `
      <div class="status-indicator disconnected"></div>
      <span>Not connected</span>
    `;
  }

  async connectToMCP() {
    try {
      // Send message to background script to check MCP connection
      const response = await chrome.runtime.sendMessage({ action: 'getMCPStatus' });
      
      if (response?.connected) {
        this.updateMCPStatus(true, response.tools || 0);
      } else {
        this.updateMCPStatus(false);
      }
    } catch (error) {
      console.error('MCP connection error:', error);
      this.updateMCPStatus(false);
    }
  }

  updateMCPStatus(connected, toolCount = 0) {
    const statusEl = this.elements.mcpStatus;
    statusEl.innerHTML = connected ? `
      <span class="status-indicator connected"></span>
      Connected
    ` : `
      <span class="status-indicator disconnected"></span>
      Disconnected
    `;
    
    this.elements.mcpTools.textContent = toolCount;
  }

  async refreshTabFilesystem() {
    try {
      const tabs = await chrome.tabs.query({});
      const filesystem = tabs.map((tab, index) => ({
        path: `/tabs/${index}/${this.sanitizePath(tab.title || 'untitled')}`,
        tabId: tab.id,
        url: tab.url,
        title: tab.title || 'Untitled',
        active: tab.active
      }));
      
      // Update UI
      this.elements.tabFs.innerHTML = filesystem.map(item => `
        <div class="tab-item ${item.active ? 'active' : ''}" data-tab-id="${item.tabId}">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2v12h12V2H2zm1 1h10v10H3V3z"/>
          </svg>
          <span title="${item.url}">${item.path}</span>
        </div>
      `).join('');
      
      // Add click handlers
      this.elements.tabFs.querySelectorAll('.tab-item').forEach(item => {
        item.addEventListener('click', () => {
          const tabId = parseInt(item.dataset.tabId);
          chrome.tabs.update(tabId, { active: true });
        });
      });
      
    } catch (error) {
      console.error('Error refreshing tab filesystem:', error);
    }
  }

  sanitizePath(title) {
    return title.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase().substring(0, 30);
  }

  async checkWebGPU() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'checkWebGPU' });
      
      if (response?.available) {
        this.elements.gpuStatus.innerHTML = `
          <span class="status-indicator connected"></span>
          Available
        `;
        this.elements.gpuModel.textContent = response.adapter || 'Unknown';
        this.elements.gpuMemory.textContent = response.memory || '-';
      } else {
        this.elements.gpuStatus.innerHTML = `
          <span class="status-indicator disconnected"></span>
          Not Available
        `;
      }
    } catch (error) {
      console.error('WebGPU check error:', error);
    }
  }

  updateAgentList() {
    const agentArray = Array.from(this.agents.values());
    this.elements.agentCount.textContent = agentArray.length;
    
    if (agentArray.length === 0) {
      this.elements.agentList.innerHTML = '<div class="empty-state">No active agents</div>';
      return;
    }
    
    this.elements.agentList.innerHTML = agentArray.map(agent => `
      <div class="agent-item">
        <div class="agent-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10" stroke-width="2"/>
            <path d="M12 6v6l4 2" stroke-width="2"/>
          </svg>
        </div>
        <div class="agent-info">
          <div class="agent-name">${agent.name}</div>
          <div class="agent-status">${agent.status} • Tab ${agent.tabId}</div>
        </div>
        <div class="agent-actions">
          <button class="icon-btn small" onclick="hanzoSidebar.pauseAgent('${agent.id}')">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 3v10M10 3v10" stroke-width="2"/>
            </svg>
          </button>
          <button class="icon-btn small" onclick="hanzoSidebar.stopAgent('${agent.id}')">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <rect x="4" y="4" width="8" height="8" stroke-width="2"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');
  }

  updateProcessList() {
    const processArray = Array.from(this.processes.values());
    this.elements.processCount.textContent = processArray.length;
    
    if (processArray.length === 0) {
      this.elements.processList.innerHTML = '<div class="empty-state">No running processes</div>';
      return;
    }
    
    this.elements.processList.innerHTML = processArray.map(proc => `
      <div class="process-item">
        <span class="process-name">${proc.name}</span>
        <span class="process-time">${this.formatDuration(proc.startTime)}</span>
      </div>
    `).join('');
  }

  formatDuration(startTime) {
    const elapsed = Date.now() - startTime;
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  showAgentLauncher() {
    // Create agent launcher modal
    const modal = document.createElement('div');
    modal.className = 'agent-launcher-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>Launch Agent</h3>
        <label>
          Agent Type
          <select id="agent-type">
            <option value="browser-control">Browser Control</option>
            <option value="data-extraction">Data Extraction</option>
            <option value="form-automation">Form Automation</option>
            <option value="testing">Testing</option>
          </select>
        </label>
        <label>
          Target Tab
          <select id="target-tab">
            <option value="current">Current Tab</option>
            <option value="all">All Tabs</option>
          </select>
        </label>
        <label>
          Model
          <select id="agent-model">
            <option value="local">Local (WebGPU)</option>
            <option value="claude">Claude</option>
            <option value="gpt4">GPT-4</option>
          </select>
        </label>
        <div class="modal-actions">
          <button class="btn secondary" onclick="this.parentElement.parentElement.parentElement.remove()">Cancel</button>
          <button class="btn primary" onclick="hanzoSidebar.launchAgent()">Launch</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
  }

  async launchAgent() {
    const type = document.getElementById('agent-type').value;
    const target = document.getElementById('target-tab').value;
    const model = document.getElementById('agent-model').value;
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'launchAgent',
        config: { type, target, model }
      });
      
      if (response.success) {
        this.agents.set(response.agentId, {
          id: response.agentId,
          name: `${type}-${response.agentId.slice(0, 6)}`,
          status: 'Running',
          tabId: response.tabId,
          type,
          model
        });
        
        this.updateAgentList();
        document.querySelector('.agent-launcher-modal').remove();
      }
    } catch (error) {
      console.error('Error launching agent:', error);
    }
  }

  showSettings() {
    this.elements.settingsPanel.classList.remove('hidden');
  }

  hideSettings() {
    this.elements.settingsPanel.classList.add('hidden');
  }

  async saveSettings() {
    const settings = {
      mcpUrl: document.getElementById('mcp-url').value,
      autoReconnect: document.getElementById('auto-reconnect').checked,
      enableWebGPU: document.getElementById('enable-webgpu').checked,
      quantization: document.getElementById('quantization').value,
      safeMode: document.getElementById('safe-mode').checked,
      maxAgents: parseInt(document.getElementById('max-agents').value)
    };
    
    await chrome.storage.local.set({ settings });
    this.hideSettings();
    this.showNotification('Settings saved');
  }

  showNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => notification.remove(), 3000);
  }

  showError(message) {
    const error = document.createElement('div');
    error.className = 'notification error';
    error.textContent = message;
    document.body.appendChild(error);
    
    setTimeout(() => error.remove(), 5000);
  }

  handleMessage(request, sender, sendResponse) {
    switch (request.action) {
      case 'agentUpdate':
        if (request.agentId && this.agents.has(request.agentId)) {
          this.agents.get(request.agentId).status = request.status;
          this.updateAgentList();
        }
        break;
        
      case 'processUpdate':
        if (request.processId) {
          if (request.status === 'started') {
            this.processes.set(request.processId, {
              id: request.processId,
              name: request.name,
              startTime: Date.now()
            });
          } else if (request.status === 'ended') {
            this.processes.delete(request.processId);
          }
          this.updateProcessList();
        }
        break;
    }
  }

  pauseAgent(agentId) {
    chrome.runtime.sendMessage({ action: 'pauseAgent', agentId });
  }

  stopAgent(agentId) {
    chrome.runtime.sendMessage({ action: 'stopAgent', agentId });
    this.agents.delete(agentId);
    this.updateAgentList();
  }

  startMonitoring() {
    // Initial checks
    this.refreshTabFilesystem();
    this.checkWebGPU();
    
    // Periodic updates
    setInterval(() => {
      this.connectToMCP();
      this.updateProcessList();
    }, 5000);
    
    // Tab change listener
    chrome.tabs.onUpdated.addListener(() => this.refreshTabFilesystem());
    chrome.tabs.onRemoved.addListener(() => this.refreshTabFilesystem());
  }
}

// Initialize sidebar
const hanzoSidebar = new HanzoSidebar();