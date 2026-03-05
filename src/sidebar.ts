// Hanzo AI Browser Extension Sidebar — Chat + Tools + Settings

class HanzoSidebar {
  constructor() {
    this.agents = new Map();
    this.currentTab = 'chat';
    this.messages = [];
    this.streaming = false;
    this.streamController = null;
    this.authenticated = false;
    this.ragContext = null;

    this.initializeUI();
    this.setupEventListeners();
    this.checkAuth();
  }

  initializeUI() {
    this.el = {
      // Auth
      authSection: document.getElementById('auth-section'),
      authBtn: document.getElementById('auth-btn'),
      tabBar: document.getElementById('tab-bar'),
      userBadge: document.getElementById('user-badge'),
      headerAvatar: document.getElementById('header-avatar'),

      // Chat
      tabChat: document.getElementById('tab-chat'),
      chatMessages: document.getElementById('chat-messages'),
      chatInput: document.getElementById('chat-input'),
      sendBtn: document.getElementById('send-btn'),
      modelSelect: document.getElementById('model-select'),
      ragEnabled: document.getElementById('rag-enabled'),
      tabContextEnabled: document.getElementById('tab-context-enabled'),
      ragStatus: document.getElementById('rag-status'),

      // Tools
      tabTools: document.getElementById('tab-tools'),
      mcpStatus: document.getElementById('mcp-status'),
      mcpTools: document.getElementById('mcp-tools'),
      mcpToolList: document.getElementById('mcp-tool-list'),
      agentCount: document.getElementById('agent-count'),
      agentList: document.getElementById('agent-list'),
      tabFs: document.getElementById('tab-fs'),
      refreshTabs: document.getElementById('refresh-tabs'),
      gpuStatus: document.getElementById('gpu-status'),
      gpuModel: document.getElementById('gpu-model'),
      launchAgent: document.getElementById('launch-agent'),

      // Settings
      tabSettings: document.getElementById('tab-settings'),
      userAvatar: document.getElementById('user-avatar'),
      userName: document.getElementById('user-name'),
      userEmail: document.getElementById('user-email'),
      logoutBtn: document.getElementById('logout-btn'),
      saveSettings: document.getElementById('save-settings'),
      defaultModel: document.getElementById('default-model'),
      ragUseZap: document.getElementById('rag-use-zap'),
      ragIncludeTabContext: document.getElementById('rag-include-tab-context'),
      ragTopK: document.getElementById('rag-top-k'),
      ragKb: document.getElementById('rag-kb'),
      ragEndpoint: document.getElementById('rag-endpoint'),
      ragApiKey: document.getElementById('rag-api-key'),
    };
  }

  setupEventListeners() {
    // Auth
    this.el.authBtn?.addEventListener('click', () => this.login());

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Chat
    this.el.sendBtn.addEventListener('click', () => this.sendMessage());
    this.el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.el.chatInput.addEventListener('input', () => this.autoResize());
    this.el.ragEnabled?.addEventListener('change', () => {
      this.setRagStatus(this.el.ragEnabled.checked ? 'RAG enabled' : 'RAG disabled');
    });
    this.el.tabContextEnabled?.addEventListener('change', () => {
      if (!this.el.ragEnabled?.checked) return;
      this.setRagStatus(this.el.tabContextEnabled.checked ? 'Tab context on' : 'Tab context off');
    });

    // Tools
    this.el.refreshTabs?.addEventListener('click', () => this.refreshTabFilesystem());
    this.el.launchAgent?.addEventListener('click', () => this.showAgentLauncher());

    // Settings
    this.el.logoutBtn?.addEventListener('click', () => this.logout());
    this.el.saveSettings?.addEventListener('click', () => this.saveSettings());

    // Background messages
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request);
      return true;
    });
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  async checkAuth() {
    // Always show tabs and initialize tools — auth only gates chat
    this.el.tabBar.classList.remove('hidden');
    this.el.authSection.classList.add('hidden');

    // Initialize features that work without auth
    this.connectToMCP();
    this.refreshTabFilesystem();
    this.checkWebGPU();
    this.loadSettings();
    this.startMonitoring();

    try {
      const response = await chrome.runtime.sendMessage({ action: 'auth.status' });
      if (response?.success && response.authenticated) {
        this.setUser(response.user);
        this.switchTab('chat');
      } else {
        this.showChatLoginPrompt();
        this.switchTab('chat'); // Show chat tab with login prompt
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      this.showChatLoginPrompt();
      this.switchTab('chat');
    }
  }

  async login() {
    this.el.authBtn.disabled = true;
    this.el.authBtn.textContent = 'Signing in...';

    try {
      const response = await chrome.runtime.sendMessage({ action: 'auth.login' });
      if (response?.success) {
        this.setUser(response.user);
        this.hideChatLoginPrompt();
      } else {
        this.showError(response?.error || 'Sign in failed');
      }
    } catch (error) {
      this.showError('Sign in failed');
    } finally {
      this.el.authBtn.disabled = false;
      this.el.authBtn.textContent = 'Sign in';
    }
  }

  async logout() {
    await chrome.runtime.sendMessage({ action: 'auth.logout' });
    this.el.userBadge.classList.add('hidden');
    this.el.userName.textContent = '';
    this.el.userEmail.textContent = '';
    this.showChatLoginPrompt();
    this.switchTab('tools');
  }

  setUser(user) {
    this.authenticated = true;
    if (user) {
      const avatar = user.picture || user.avatar || '';
      if (avatar) {
        this.el.headerAvatar.src = avatar;
        this.el.userBadge.classList.remove('hidden');
        this.el.userAvatar.src = avatar;
      }
      this.el.userName.textContent = user.name || user.displayName || 'User';
      this.el.userEmail.textContent = user.email || '';
    }
    this.loadModels();
    this.loadConversation();
  }

  showChatLoginPrompt() {
    this.authenticated = false;
    // Show login prompt in chat area instead of blocking entire sidebar
    const chatLogin = document.getElementById('chat-login-prompt');
    if (chatLogin) chatLogin.classList.remove('hidden');
    const chatComposer = document.getElementById('chat-composer');
    if (chatComposer) chatComposer.classList.add('hidden');
  }

  hideChatLoginPrompt() {
    this.authenticated = true;
    const chatLogin = document.getElementById('chat-login-prompt');
    if (chatLogin) chatLogin.classList.add('hidden');
    const chatComposer = document.getElementById('chat-composer');
    if (chatComposer) chatComposer.classList.remove('hidden');
  }

  // ===========================================================================
  // Tab Navigation
  // ===========================================================================

  switchTab(name) {
    this.currentTab = name;

    // Update tab buttons
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === name);
    });

    // Show/hide content
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    const target = document.getElementById(`tab-${name}`);
    if (target) target.classList.remove('hidden');
  }

  // ===========================================================================
  // Chat
  // ===========================================================================

  async loadModels() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'chat.listModels' });
      if (response?.success && response.models?.length) {
        const select = this.el.modelSelect;
        select.innerHTML = '';
        for (const model of response.models) {
          const opt = document.createElement('option');
          opt.value = model.id;
          opt.textContent = model.name || model.id;
          select.appendChild(opt);
        }
        // Also populate settings default model
        this.el.defaultModel.innerHTML = select.innerHTML;
      }
    } catch {
      // Keep default options
    }
  }

  async sendMessage() {
    const text = this.el.chatInput.value.trim();
    if (!text || this.streaming) return;
    if (!this.authenticated) {
      this.showError('Please sign in to use chat');
      return;
    }

    // Get token
    const tokenResp = await chrome.runtime.sendMessage({ action: 'auth.getToken' });
    if (!tokenResp?.success || !tokenResp.token) {
      this.showError('Please sign in again');
      return;
    }

    const userMessage = { role: 'user', content: text };
    const model = this.el.modelSelect.value;
    let requestMessages = [...this.messages, userMessage];

    this.ragContext = null;
    if (this.el.ragEnabled?.checked) {
      this.setRagStatus('Retrieving context...');
      const ragResp = await this.requestRagContext(text);
      if (ragResp?.success && Array.isArray(ragResp.snippets) && ragResp.snippets.length) {
        this.ragContext = ragResp;
        requestMessages = [
          { role: 'system', content: this.buildRagSystemPrompt(ragResp) },
          ...requestMessages,
        ];
        this.setRagStatus(`RAG: ${ragResp.snippets.length} snippet(s) from ${ragResp.source || 'context'}`);
      } else if (ragResp?.error) {
        this.setRagStatus(`RAG unavailable (${ragResp.error})`);
      } else {
        this.setRagStatus('No context found');
      }
    } else {
      this.setRagStatus('RAG disabled');
    }

    // Add user message to transcript
    this.messages.push(userMessage);
    this.appendMessage('user', text);

    // Clear input
    this.el.chatInput.value = '';
    this.autoResize();

    // Show typing
    this.streaming = true;
    this.el.sendBtn.disabled = true;
    const typingEl = this.showTyping();

    // Create assistant message element
    const assistantEl = this.appendMessage('assistant', '');
    let fullContent = '';

    try {
      // Stream via direct fetch (sidebar has access via CSP)
      const response = await fetch('https://api.hanzo.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenResp.token}`,
        },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          stream: true,
        }),
        signal: (this.streamController = new AbortController()).signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      typingEl.remove();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                assistantEl.innerHTML = this.renderMarkdown(fullContent);
                this.scrollToBottom();
              }
            } catch {}
          }
        }
      }

      if (this.ragContext?.snippets?.length) {
        fullContent += this.buildRagCitationBlock(this.ragContext);
        assistantEl.innerHTML = this.renderMarkdown(fullContent);
      }

      this.messages.push({ role: 'assistant', content: fullContent });
      this.saveConversation();
    } catch (error) {
      typingEl.remove();
      if (error?.name !== 'AbortError') {
        assistantEl.remove();
        this.appendError(error?.message || 'Chat failed');
      }
    } finally {
      this.streaming = false;
      this.streamController = null;
      this.el.sendBtn.disabled = false;
    }
  }

  async getActiveTabContext() {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return null;
      return {
        url: activeTab.url || '',
        title: activeTab.title || '',
      };
    } catch {
      return null;
    }
  }

  async requestRagContext(query) {
    try {
      const pageContext = this.el.tabContextEnabled?.checked ? await this.getActiveTabContext() : null;
      const topK = Math.max(1, Math.min(parseInt(this.el.ragTopK?.value || '5', 10) || 5, 20));

      return await chrome.runtime.sendMessage({
        action: 'rag.query',
        query,
        topK,
        includeTabContext: !!this.el.tabContextEnabled?.checked,
        useZapMemory: !!this.el.ragUseZap?.checked,
        knowledgeBase: this.el.ragKb?.value || '',
        endpoint: this.el.ragEndpoint?.value || '',
        apiKey: this.el.ragApiKey?.value || '',
        pageContext: pageContext || undefined,
      });
    } catch (error) {
      return { success: false, error: error?.message || 'Failed to query RAG' };
    }
  }

  buildRagSystemPrompt(ragResponse) {
    const snippets = (ragResponse?.snippets || []).slice(0, 8);
    const lines = snippets.map((snippet, index) => {
      const title = snippet.title || snippet.source || `Snippet ${index + 1}`;
      const score = typeof snippet.score === 'number' ? ` (score ${snippet.score.toFixed(3)})` : '';
      const sourceLine = snippet.url ? `${title}${score} — ${snippet.url}` : `${title}${score}`;
      return `[${index + 1}] ${sourceLine}\n${snippet.content}`;
    });

    return [
      'You are assisting inside Hanzo Browser Extension.',
      'Use the retrieved context below when relevant, and state uncertainty if context is insufficient.',
      'Retrieved Context:',
      ...lines,
    ].join('\n\n');
  }

  buildRagCitationBlock(ragResponse) {
    const snippets = (ragResponse?.snippets || []).slice(0, 5);
    if (!snippets.length) return '';

    const rows = snippets.map((snippet, index) => {
      const title = snippet.title || snippet.source || `Snippet ${index + 1}`;
      if (snippet.url) {
        return `- ${title}: ${snippet.url}`;
      }
      return `- ${title}`;
    });

    return `\n\n---\nContext Sources:\n${rows.join('\n')}`;
  }

  setRagStatus(text) {
    if (!this.el.ragStatus) return;
    this.el.ragStatus.textContent = text || 'Ready';
  }

  appendMessage(role, content) {
    // Remove welcome message
    const welcome = this.el.chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `msg msg-${role}`;
    div.innerHTML = role === 'assistant' ? this.renderMarkdown(content) : this.escapeHtml(content);
    this.el.chatMessages.appendChild(div);
    this.scrollToBottom();
    return div;
  }

  appendError(message) {
    const div = document.createElement('div');
    div.className = 'msg-error';
    div.textContent = message;
    this.el.chatMessages.appendChild(div);
    this.scrollToBottom();
  }

  showTyping() {
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    this.el.chatMessages.appendChild(div);
    this.scrollToBottom();
    return div;
  }

  scrollToBottom() {
    this.el.chatMessages.scrollTop = this.el.chatMessages.scrollHeight;
  }

  autoResize() {
    const el = this.el.chatInput;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  // Minimal markdown: code blocks, inline code, bold, italic, line breaks
  renderMarkdown(text) {
    if (!text) return '';
    let html = this.escapeHtml(text);

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **...**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic: *...*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async loadConversation() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['hanzo_chat_messages'], (result) => {
        if (result.hanzo_chat_messages?.length) {
          this.messages = result.hanzo_chat_messages;
          // Render stored messages
          const welcome = this.el.chatMessages.querySelector('.chat-welcome');
          if (welcome) welcome.remove();
          for (const msg of this.messages) {
            this.appendMessage(msg.role, msg.content);
          }
        }
        resolve();
      });
    });
  }

  saveConversation() {
    // Keep last 50 messages
    const toStore = this.messages.slice(-50);
    chrome.storage.local.set({ hanzo_chat_messages: toStore });
  }

  // ===========================================================================
  // Tools Tab
  // ===========================================================================

  async connectToMCP() {
    try {
      const zapResponse = await chrome.runtime.sendMessage({ action: 'zap.status' });
      if (zapResponse?.success) {
        const zap = zapResponse.zap;
        const toolCount = zap.mcps?.reduce((sum, m) => sum + (m.tools?.length || 0), 0) || 0;
        this.updateMCPStatus(zap.connected, toolCount, zap.mcps?.length || 0);
        if (zap.connected) {
          const toolsResp = await chrome.runtime.sendMessage({ action: 'zap.listTools' });
          this.updateMCPToolList(toolsResp?.success ? toolsResp.tools : []);
        } else {
          this.updateMCPToolList([]);
        }
      } else {
        this.updateMCPStatus(false);
        this.updateMCPToolList([]);
      }
    } catch {
      this.updateMCPStatus(false);
      this.updateMCPToolList([]);
    }
  }

  updateMCPStatus(connected, toolCount = 0, mcpCount = 0) {
    this.el.mcpStatus.innerHTML = connected ? `
      <span class="status-indicator connected"></span>
      ${mcpCount > 0 ? `ZAP: ${mcpCount} MCP(s)` : 'Connected'}
    ` : `
      <span class="status-indicator disconnected"></span>
      Disconnected
    `;
    this.el.mcpTools.textContent = toolCount;
  }

  updateMCPToolList(tools) {
    if (!this.el.mcpToolList) return;
    if (!tools || !tools.length) {
      this.el.mcpToolList.textContent = 'No tools discovered yet.';
      return;
    }

    const names = Array.from(new Set(tools.map((tool) => tool.name))).sort();
    const preview = names.slice(0, 20);
    const suffix = names.length > preview.length ? `\n... +${names.length - preview.length} more` : '';
    this.el.mcpToolList.textContent = `${preview.join('\n')}${suffix}`;
  }

  async refreshTabFilesystem() {
    try {
      const tabs = await chrome.tabs.query({});
      this.el.tabFs.innerHTML = tabs.map((tab, i) => `
        <div class="tab-item ${tab.active ? 'active' : ''}" data-tab-id="${tab.id}">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2v12h12V2H2zm1 1h10v10H3V3z"/>
          </svg>
          <span title="${this.escapeHtml(tab.url || '')}">/tabs/${i}/${this.sanitizePath(tab.title || 'untitled')}</span>
        </div>
      `).join('');

      this.el.tabFs.querySelectorAll('.tab-item').forEach(item => {
        item.addEventListener('click', () => {
          chrome.tabs.update(parseInt(item.dataset.tabId), { active: true });
        });
      });
    } catch {}
  }

  sanitizePath(title) {
    return title.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase().substring(0, 30);
  }

  async checkWebGPU() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'checkWebGPU' });
      if (response?.available) {
        this.el.gpuStatus.innerHTML = `
          <span class="status-indicator connected"></span>
          Available
        `;
        this.el.gpuModel.textContent = response.adapter || 'Unknown';
      } else {
        this.el.gpuStatus.innerHTML = `
          <span class="status-indicator disconnected"></span>
          Not Available
        `;
      }
    } catch {}
  }

  updateAgentList() {
    const arr = Array.from(this.agents.values());
    this.el.agentCount.textContent = arr.length;
    if (arr.length === 0) {
      this.el.agentList.innerHTML = '<div class="empty-state">No active agents</div>';
      return;
    }
    this.el.agentList.innerHTML = arr.map(a => `
      <div class="agent-item">
        <div class="agent-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10" stroke-width="2"/>
            <path d="M12 6v6l4 2" stroke-width="2"/>
          </svg>
        </div>
        <div class="agent-info">
          <div class="agent-name">${this.escapeHtml(a.name)}</div>
          <div class="agent-status">${a.status} • Tab ${a.tabId}</div>
        </div>
        <div class="agent-actions">
          <button class="icon-btn small" data-stop="${a.id}" title="Stop">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <rect x="4" y="4" width="8" height="8" stroke-width="2"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    this.el.agentList.querySelectorAll('[data-stop]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.stop;
        chrome.runtime.sendMessage({ action: 'stopAgent', agentId: id });
        this.agents.delete(id);
        this.updateAgentList();
      });
    });
  }

  showAgentLauncher() {
    // Create agent launcher modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Launch Agent</h3>
          <button class="icon-btn close-modal">&times;</button>
        </div>
        <div class="modal-body">
          <label class="setting-item">
            <span>Target Tab</span>
            <select id="agent-tab-select">
              <option value="active">Active Tab</option>
            </select>
          </label>
          <label class="setting-item">
            <span>Agent Type</span>
            <select id="agent-type-select">
              <option value="browser-control">Browser Automation</option>
              <option value="page-analyzer">Page Analyzer</option>
              <option value="form-filler">Form Filler</option>
              <option value="data-extractor">Data Extractor</option>
            </select>
          </label>
          <label class="setting-item">
            <span>Instructions</span>
            <textarea id="agent-instructions" rows="3" placeholder="Describe what the agent should do..."></textarea>
          </label>
        </div>
        <div class="modal-footer">
          <button class="secondary-btn cancel-modal">Cancel</button>
          <button class="primary-btn launch-modal">Launch</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Populate tabs
    chrome.tabs.query({}, (tabs) => {
      const select = overlay.querySelector('#agent-tab-select');
      tabs.forEach(tab => {
        if (tab.id) {
          const opt = document.createElement('option');
          opt.value = tab.id;
          opt.textContent = `${tab.title?.substring(0, 40) || 'Untitled'} ${tab.active ? '(active)' : ''}`;
          select.appendChild(opt);
        }
      });
    });

    // Close handlers
    overlay.querySelector('.close-modal').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.cancel-modal').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // Launch handler
    overlay.querySelector('.launch-modal').addEventListener('click', async () => {
      const tabSelect = overlay.querySelector('#agent-tab-select');
      const typeSelect = overlay.querySelector('#agent-type-select');
      const instructions = overlay.querySelector('#agent-instructions');

      let tabId;
      if (tabSelect.value === 'active') {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = activeTab?.id;
      } else {
        tabId = parseInt(tabSelect.value);
      }

      if (!tabId) {
        this.showError('No tab selected');
        return;
      }

      const agentType = typeSelect.value;
      const agentInstructions = instructions.value?.trim() || '';
      overlay.remove();

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'launchAIWorker',
          tabId,
          model: agentType,
          instructions: agentInstructions,
        });

        if (response?.success) {
          const agentId = response.agentId || `agent-${Date.now().toString(36)}`;
          this.agents.set(agentId, {
            id: agentId,
            name: agentType,
            tabId,
            status: 'running',
          });
          this.updateAgentList();
          this.showNotification(`Agent launched on tab ${tabId}`);
        } else {
          this.showError(response?.error || 'Failed to launch agent');
        }
      } catch (error) {
        this.showError('Failed to launch agent: ' + error.message);
      }
    });
  }

  // ===========================================================================
  // Settings Tab
  // ===========================================================================

  loadSettings() {
    chrome.storage.local.get([
      'mcpPort',
      'cdpPort',
      'zapPorts',
      'hanzo_default_model',
      'hanzo_rag_endpoint',
      'hanzo_rag_api_key',
      'hanzo_rag_kb',
      'hanzo_rag_top_k',
      'hanzo_rag_include_tab_context',
      'hanzo_rag_use_zap',
      'hanzo_chat_rag_enabled',
      'hanzo_chat_tab_context_enabled',
    ], (result) => {
      const mcpPort = document.getElementById('mcp-port-setting');
      const cdpPort = document.getElementById('cdp-port-setting');
      const zapPorts = document.getElementById('zap-ports-setting');

      if (mcpPort) mcpPort.value = result.mcpPort || 3001;
      if (cdpPort) cdpPort.value = result.cdpPort || 9223;
      if (zapPorts) zapPorts.value = (result.zapPorts || [9999,9998,9997,9996,9995]).join(',');
      if (result.hanzo_default_model && this.el.defaultModel) {
        this.el.defaultModel.value = result.hanzo_default_model;
      }

      if (this.el.ragEndpoint) this.el.ragEndpoint.value = result.hanzo_rag_endpoint || '';
      if (this.el.ragApiKey) this.el.ragApiKey.value = result.hanzo_rag_api_key || '';
      if (this.el.ragKb) this.el.ragKb.value = result.hanzo_rag_kb || '';
      if (this.el.ragTopK) this.el.ragTopK.value = String(result.hanzo_rag_top_k || 5);
      if (this.el.ragIncludeTabContext) this.el.ragIncludeTabContext.checked = result.hanzo_rag_include_tab_context !== false;
      if (this.el.ragUseZap) this.el.ragUseZap.checked = result.hanzo_rag_use_zap !== false;
      if (this.el.ragEnabled) this.el.ragEnabled.checked = result.hanzo_chat_rag_enabled !== false;
      if (this.el.tabContextEnabled) this.el.tabContextEnabled.checked = result.hanzo_chat_tab_context_enabled !== false;
      this.setRagStatus(this.el.ragEnabled?.checked ? 'Ready' : 'RAG disabled');
    });
  }

  async saveSettings() {
    const mcpPort = parseInt(document.getElementById('mcp-port-setting')?.value) || 3001;
    const cdpPort = parseInt(document.getElementById('cdp-port-setting')?.value) || 9223;
    const zapPorts = (document.getElementById('zap-ports-setting')?.value || '')
      .split(',').map(p => parseInt(p.trim())).filter(p => p > 0 && p < 65536);

    await chrome.storage.local.set({
      mcpPort,
      cdpPort,
      zapPorts: zapPorts.length ? zapPorts : [9999,9998,9997,9996,9995],
      hanzo_default_model: this.el.defaultModel?.value || 'gpt-4o',
      'safe-mode': document.getElementById('safe-mode')?.checked,
      'enable-webgpu': document.getElementById('enable-webgpu')?.checked,
      maxAgents: parseInt(document.getElementById('max-agents')?.value) || 3,
      hanzo_rag_endpoint: this.el.ragEndpoint?.value?.trim() || '',
      hanzo_rag_api_key: this.el.ragApiKey?.value?.trim() || '',
      hanzo_rag_kb: this.el.ragKb?.value?.trim() || '',
      hanzo_rag_top_k: Math.max(1, Math.min(parseInt(this.el.ragTopK?.value || '5', 10) || 5, 20)),
      hanzo_rag_include_tab_context: !!this.el.ragIncludeTabContext?.checked,
      hanzo_rag_use_zap: !!this.el.ragUseZap?.checked,
      hanzo_chat_rag_enabled: !!this.el.ragEnabled?.checked,
      hanzo_chat_tab_context_enabled: !!this.el.tabContextEnabled?.checked,
    });

    this.showNotification('Settings saved');
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  startMonitoring() {
    setInterval(() => this.connectToMCP(), 10000);
    chrome.tabs.onUpdated.addListener(() => this.refreshTabFilesystem());
    chrome.tabs.onRemoved.addListener(() => this.refreshTabFilesystem());
  }

  handleMessage(request) {
    switch (request.action) {
      case 'agentUpdate':
        if (request.agentId && this.agents.has(request.agentId)) {
          this.agents.get(request.agentId).status = request.status;
          this.updateAgentList();
        }
        break;
    }
  }

  showNotification(message) {
    const el = document.createElement('div');
    el.className = 'notification';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  showError(message) {
    const el = document.createElement('div');
    el.className = 'notification error';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

// Initialize
const hanzoSidebar = new HanzoSidebar();
