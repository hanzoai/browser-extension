// Hanzo AI — Popup Script
// Uses background message passing for auth (not direct storage access).

document.addEventListener('DOMContentLoaded', () => {
  const loginSection = document.getElementById('login-section');
  const mainSection = document.getElementById('main-section');
  const settingsSection = document.getElementById('settings-section');

  // Auth
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');

  // Open panel
  const openPanel = document.getElementById('open-panel');
  const openPageOverlay = document.getElementById('open-page-overlay');

  // Status dots
  const zapStatus = document.getElementById('zap-status');
  const zapDetail = document.getElementById('zap-detail');
  const mcpStatus = document.getElementById('mcp-status');
  const mcpPort = document.getElementById('mcp-port');
  const cdpStatus = document.getElementById('cdp-status');
  const cdpDetail = document.getElementById('cdp-detail');
  const gpuStatus = document.getElementById('gpu-status');
  const gpuDetail = document.getElementById('gpu-detail');

  // Settings
  const openSettings = document.getElementById('open-settings');
  const backBtn = document.getElementById('back-btn');
  const saveSettings = document.getElementById('save-settings');
  const testConnection = document.getElementById('test-connection');

  // --- Auth via background ---
  function checkAuth() {
    // Always show main section and status (tools work without login)
    mainSection.classList.remove('hidden');
    refreshStatus();

    chrome.runtime.sendMessage({ action: 'auth.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success && response.authenticated) {
        loginSection.classList.add('hidden');
        if (response.user) {
          const avatar = document.getElementById('user-avatar');
          const name = document.getElementById('user-name');
          const email = document.getElementById('user-email');
          avatar.src = response.user.picture || response.user.avatar || 'icon48.png';
          name.textContent = response.user.name || response.user.displayName || 'Hanzo User';
          email.textContent = response.user.email || '';
        }
      } else {
        loginSection.classList.remove('hidden');
      }
    });
  }

  loginBtn?.addEventListener('click', () => {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
    chrome.runtime.sendMessage({ action: 'auth.login' }, (response) => {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in with Hanzo';
      if (response?.success) {
        checkAuth();
      } else {
        const msg = response?.error || 'Unable to sign in. Please try again.';
        loginBtn.textContent = msg;
        setTimeout(() => { loginBtn.textContent = 'Sign in with Hanzo'; }, 3000);
      }
    });
  });

  logoutBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'auth.logout' }, () => {
      loginSection.classList.remove('hidden');
      // Keep main section visible — tools work without auth
      const avatar = document.getElementById('user-avatar') as HTMLImageElement;
      const name = document.getElementById('user-name');
      const email = document.getElementById('user-email');
      if (avatar) avatar.src = '';
      if (name) name.textContent = '';
      if (email) email.textContent = '';
    });
  });

  // --- Open side panel ---
  openPanel?.addEventListener('click', () => {
    if (chrome.sidePanel) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.sidePanel.open({ tabId: tabs[0].id });
        }
      });
    } else {
      // Firefox: sidebar_action is automatic
      window.close();
    }
  });

  function isInjectableTab(tab: chrome.tabs.Tab | undefined): boolean {
    if (!tab || !tab.id) return false;
    const url = tab.url || '';
    if (!url) return false;
    if (url.startsWith('chrome://')) return false;
    if (url.startsWith('chrome-extension://')) return false;
    if (url.startsWith('devtools://')) return false;
    if (url.startsWith('edge://')) return false;
    if (url.startsWith('about:')) return false;
    if (url.startsWith('view-source:')) return false;
    if (url.startsWith('moz-extension://')) return false;
    return true;
  }

  openPageOverlay?.addEventListener('click', () => {
    openPageOverlay.textContent = 'Opening...';
    openPageOverlay.setAttribute('disabled', 'true');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      let targetTab = isInjectableTab(activeTab) ? activeTab : null;

      if (!targetTab) {
        chrome.tabs.query({ currentWindow: true }, (allTabs) => {
          targetTab = allTabs.find((tab) => isInjectableTab(tab)) || null;
          if (!targetTab?.id) {
            openPageOverlay.textContent = 'No valid page tab';
            setTimeout(() => {
              openPageOverlay.textContent = 'Toggle On-Page Overlay';
              openPageOverlay.removeAttribute('disabled');
            }, 1200);
            return;
          }

          chrome.runtime.sendMessage({ action: 'page.overlay.toggle', tabId: targetTab.id }, (response) => {
            if (chrome.runtime.lastError || !response?.success) {
              openPageOverlay.textContent = 'Unavailable on this page';
            } else {
              const opened = !!response?.open;
              openPageOverlay.textContent = opened ? 'Overlay Opened' : 'Overlay Hidden';
            }
            setTimeout(() => {
              openPageOverlay.textContent = 'Toggle On-Page Overlay';
              openPageOverlay.removeAttribute('disabled');
            }, 900);
          });
        });
        return;
      }

      if (!targetTab?.id) {
        openPageOverlay.textContent = 'No Active Tab';
        setTimeout(() => {
          openPageOverlay.textContent = 'Toggle On-Page Overlay';
          openPageOverlay.removeAttribute('disabled');
        }, 1200);
        return;
      }

      chrome.runtime.sendMessage({ action: 'page.overlay.toggle', tabId: targetTab.id }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          openPageOverlay.textContent = 'Unavailable on this page';
        } else {
          const opened = !!response?.open;
          openPageOverlay.textContent = opened ? 'Overlay Opened' : 'Overlay Hidden';
        }
        setTimeout(() => {
          openPageOverlay.textContent = 'Toggle On-Page Overlay';
          openPageOverlay.removeAttribute('disabled');
        }, 900);
      });
    });
  });

  // --- Status ---
  function refreshStatus() {
    // ZAP status
    chrome.runtime.sendMessage({ action: 'zap.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success) {
        const zap = response.zap;
        if (zap.connected) {
          zapStatus.classList.add('connected');
          zapStatus.classList.remove('disconnected');
          const mcpCount = zap.mcps?.length || 0;
          const toolCount = zap.mcps?.reduce((sum, m) => sum + (m.tools?.length || 0), 0) || 0;
          zapDetail.textContent = `${mcpCount} MCP(s), ${toolCount} tools`;
        } else {
          zapStatus.classList.remove('connected');
          zapStatus.classList.add('disconnected');
          zapDetail.textContent = 'Not connected';
        }
      }
    });

    // GPU status
    chrome.runtime.sendMessage({ action: 'checkWebGPU' }, (response) => {
      if (chrome.runtime.lastError) return;
      gpuStatus.classList.add(response?.available ? 'connected' : 'disconnected');
      gpuStatus.classList.remove(response?.available ? 'disconnected' : 'connected');
      gpuDetail.textContent = response?.available ? (response.adapter || 'Available') : 'Not available';
    });

    // MCP/CDP — set as active for now (checked via ZAP)
    mcpStatus.classList.add('connected');
    mcpPort.textContent = 'Fallback';
    cdpStatus.classList.add('connected');
    cdpDetail.textContent = 'Active';
  }

  // --- Settings ---
  openSettings?.addEventListener('click', () => {
    mainSection.classList.add('hidden');
    settingsSection.classList.remove('hidden');
    loadSettings();
  });

  backBtn?.addEventListener('click', () => {
    settingsSection.classList.add('hidden');
    mainSection.classList.remove('hidden');
  });

  function loadSettings() {
    chrome.storage.local.get(['mcpPort', 'cdpPort', 'zapPorts'], (result) => {
      const mcpPortInput = document.getElementById('mcp-port-setting');
      const cdpPortInput = document.getElementById('cdp-port-setting');
      const zapPortsInput = document.getElementById('zap-ports-setting');

      if (mcpPortInput) mcpPortInput.value = result.mcpPort || 3001;
      if (cdpPortInput) cdpPortInput.value = result.cdpPort || 9223;
      if (zapPortsInput) zapPortsInput.value = (result.zapPorts || [9999, 9998, 9997, 9996, 9995]).join(',');
    });
  }

  saveSettings?.addEventListener('click', () => {
    const mcpPortVal = parseInt(document.getElementById('mcp-port-setting')?.value) || 3001;
    const cdpPortVal = parseInt(document.getElementById('cdp-port-setting')?.value) || 9223;
    const zapPortsVal = (document.getElementById('zap-ports-setting')?.value || '')
      .split(',').map(p => parseInt(p.trim())).filter(p => p > 0 && p < 65536);

    chrome.storage.local.set({
      mcpPort: mcpPortVal,
      cdpPort: cdpPortVal,
      zapPorts: zapPortsVal.length ? zapPortsVal : [9999, 9998, 9997, 9996, 9995],
    }, () => {
      saveSettings.textContent = 'Saved!';
      setTimeout(() => { saveSettings.textContent = 'Save Settings'; }, 1500);
    });
  });

  // --- Test Connection ---
  testConnection?.addEventListener('click', () => {
    testConnection.textContent = 'Testing...';
    testConnection.disabled = true;

    chrome.runtime.sendMessage({ action: 'zap.discover' }, () => {
      refreshStatus();
      testConnection.textContent = 'Test Connection';
      testConnection.disabled = false;
    });
  });

  // Feature toggles
  ['source-maps', 'webgpu-ai', 'browser-control', 'tab-filesystem'].forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      chrome.storage.local.get([id], (result) => {
        checkbox.checked = result[id] !== false; // default on
      });
      checkbox.addEventListener('change', () => {
        chrome.storage.local.set({ [id]: checkbox.checked });
      });
    }
  });

  // --- Browser Backend Picker ---
  const backendSelect = document.getElementById('browser-backend') as HTMLSelectElement | null;
  const bridgeStatus = document.getElementById('bridge-status');
  const bridgeDetail = document.getElementById('bridge-detail');

  function loadBackendPreference() {
    chrome.storage.sync.get(['browserBackend'], (result) => {
      if (backendSelect && result.browserBackend) {
        backendSelect.value = result.browserBackend;
      }
    });
  }

  function refreshBridgeStatus() {
    chrome.runtime.sendMessage({ action: 'bridge.status' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.success && response.connected) {
        bridgeStatus?.classList.add('connected');
        bridgeStatus?.classList.remove('disconnected');
        const browsers = response.browsers || [];
        bridgeDetail.textContent = browsers.length
          ? `Connected: ${browsers.join(', ')}`
          : 'Connected';
      } else {
        bridgeStatus?.classList.remove('connected');
        bridgeStatus?.classList.add('disconnected');
        bridgeDetail.textContent = 'Not connected';
      }
    });
  }

  backendSelect?.addEventListener('change', () => {
    const value = backendSelect.value;

    // Save to chrome.storage.sync (cross-device)
    chrome.storage.sync.set({ browserBackend: value });

    // Forward to background to persist via CDP bridge + sync to IAM
    chrome.runtime.sendMessage({
      action: 'config.save',
      key: 'browserBackend',
      value,
    });
  });

  loadBackendPreference();
  refreshBridgeStatus();

  // Init
  checkAuth();
});
