// Hanzo Browser Extension - Content Script
// Connects clicked elements to source code via source-maps

interface SourceLocation {
  file: string;
  line: number;
  column?: number;
}

interface ElementSelectedEvent {
  event: 'elementSelected';
  framework: string | null;
  domPath: string;
  source?: SourceLocation;
  fallbackId?: string;
}

class HanzoContentScript {
  constructor() {
    this.setupClickHandler();
    this.injectHelpers();
    this.setupMessageHandlers();
  }

  private setupClickHandler() {
    document.addEventListener('click', (e) => {
      if (!e.altKey) return;

      e.preventDefault();
      e.stopPropagation();

      const element = e.target as HTMLElement;
      const source = this.extractSourceLocation(element);
      const domPath = this.getDOMPath(element);

      const event: ElementSelectedEvent = {
        event: 'elementSelected',
        framework: this.detectFramework(),
        domPath,
        source,
        fallbackId: element.getAttribute('data-hanzo-id') || undefined,
      };

      // Route through background script (works with both ZAP and legacy MCP)
      chrome.runtime.sendMessage({ action: 'elementSelected', data: event });
    });
  }

  private setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      switch (request.action) {
        case 'ai.control.start':
          aiOverlay.show(request.task || 'AI is controlling this page');
          sendResponse({ success: true });
          return true;
        case 'ai.control.stop':
          aiOverlay.hide();
          sendResponse({ success: true });
          return true;
        case 'ai.control.cursor':
          aiOverlay.moveCursor(request.x, request.y);
          sendResponse({ success: true });
          return true;
        case 'ai.control.highlight':
          aiOverlay.highlight(request.selector);
          sendResponse({ success: true });
          return true;
        case 'ai.control.status':
          aiOverlay.updateStatus(request.text);
          sendResponse({ success: true });
          return true;
        case 'page.overlay.toggle':
          sendResponse({
            success: true,
            open: pageOverlay.toggle(),
          });
          return true;
        case 'page.overlay.show':
          pageOverlay.show();
          sendResponse({ success: true, open: true });
          return true;
        case 'page.overlay.hide':
          pageOverlay.hide();
          sendResponse({ success: true, open: false });
          return true;
        case 'page.overlay.status':
          sendResponse({ success: true, open: pageOverlay.isOpen() });
          return true;
      }

      // Tab filesystem support
      if (request.action === 'getContent') {
        sendResponse({ content: document.documentElement?.outerHTML || '' });
        return true;
      }

      if (request.action === 'setContent') {
        if (typeof request.content === 'string') {
          document.open();
          document.write(request.content);
          document.close();
        }
        sendResponse({ success: true });
        return true;
      }

      return false;
    });
  }

  private extractSourceLocation(element: HTMLElement): SourceLocation | undefined {
    const framework = this.detectFramework();

    switch (framework) {
      case 'react':
        return this.extractReactSource(element);
      case 'vue':
        return this.extractVueSource(element);
      case 'svelte':
        return this.extractSvelteSource(element);
      default:
        return undefined;
    }
  }

  private extractReactSource(element: HTMLElement): SourceLocation | undefined {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return undefined;

    const fiber = this.findReactFiber(element);
    if (!fiber) return undefined;

    const source = fiber._debugSource || fiber.pendingProps?.__source || fiber.memoizedProps?.__source;

    if (source && source.fileName) {
      return {
        file: source.fileName,
        line: source.lineNumber,
        column: source.columnNumber,
      };
    }

    return undefined;
  }

  private findReactFiber(element: HTMLElement): any {
    const key = Object.keys(element).find(
      (candidate) => candidate.startsWith('__reactInternalInstance$') || candidate.startsWith('__reactFiber$'),
    );
    return key ? (element as any)[key] : null;
  }

  private extractVueSource(element: HTMLElement): SourceLocation | undefined {
    const hook = (window as any).__VUE_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return undefined;

    let instance = (element as any).__vueParentComponent;
    if (!instance) {
      instance = (element as any).__vue__;
    }

    if (instance?.type?.__file) {
      const location: SourceLocation = {
        file: instance.type.__file,
        line: 1,
      };

      if (instance.vnode?.loc) {
        location.line = instance.vnode.loc.start.line;
        location.column = instance.vnode.loc.start.column;
      }

      return location;
    }

    return undefined;
  }

  private extractSvelteSource(element: HTMLElement): SourceLocation | undefined {
    const component = (element as any).__svelte_component;
    if (component?.$$?.ctx?.$$_location) {
      return component.$$.ctx.$$_location;
    }
    return undefined;
  }

  private detectFramework(): string | null {
    if ((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__) return 'react';
    if ((window as any).__VUE_DEVTOOLS_GLOBAL_HOOK__) return 'vue';
    if ((window as any).__svelte) return 'svelte';
    return null;
  }

  private getDOMPath(element: HTMLElement): string {
    const path: string[] = [];
    let current: HTMLElement | null = element;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        selector += `#${current.id}`;
      } else if (current.className) {
        selector += `.${current.className.split(' ').join('.')}`;
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  }

  private injectHelpers() {
    const style = document.createElement('style');
    style.textContent = `
      [data-hanzo-hover] {
        outline: 2px dashed #ff6b6b !important;
        outline-offset: 2px !important;
      }
    `;
    document.head.appendChild(style);

    document.addEventListener('mousemove', (e) => {
      document.querySelectorAll('[data-hanzo-hover]').forEach((el) => {
        el.removeAttribute('data-hanzo-hover');
      });

      if (e.altKey && e.target instanceof HTMLElement) {
        e.target.setAttribute('data-hanzo-hover', 'true');
      }
    });
  }
}

// =============================================================================
// AI Control Overlay — takeover visual feedback + user interaction lock
// =============================================================================

const aiOverlay = (() => {
  let overlay: HTMLDivElement | null = null;
  let cursor: HTMLDivElement | null = null;
  let statusEl: HTMLDivElement | null = null;
  let cancelBtn: HTMLButtonElement | null = null;
  let highlightEl: HTMLDivElement | null = null;
  let trailNodes: HTMLDivElement[] = [];
  let interactionBlockActive = false;

  const OVERLAY_ID = 'hanzo-ai-overlay';
  const STYLES_ID = 'hanzo-ai-overlay-styles';
  const BLOCKED_EVENTS = [
    'click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu',
    'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'wheel',
    'keydown', 'keyup', 'keypress',
  ];

  function injectStyles() {
    if (document.getElementById(STYLES_ID)) return;

    const style = document.createElement('style');
    style.id = STYLES_ID;
    style.textContent = `
      /* ---- Overlay backdrop ---- */
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: all;
        background:
          radial-gradient(90vw 90vh at 15% 8%, rgba(56, 189, 248, 0.10), transparent 55%),
          radial-gradient(65vw 65vh at 84% 82%, rgba(99, 102, 241, 0.10), transparent 60%),
          rgba(2, 4, 10, 0.42);
        backdrop-filter: blur(1.5px);
        opacity: 0;
        transition: opacity 300ms ease;
      }
      #${OVERLAY_ID}.hanzo-visible {
        opacity: 1;
      }

      /* ---- Pulsing cyan glow cursor ---- */
      .hanzo-ai-cursor {
        position: fixed;
        width: 24px;
        height: 24px;
        z-index: 2147483647;
        pointer-events: none;
        border-radius: 50%;
        border: 2px solid rgba(6, 182, 212, 0.95);
        box-shadow:
          0 0 8px 2px rgba(6, 182, 212, 0.45),
          0 0 24px 6px rgba(6, 182, 212, 0.18);
        transform: translate(-50%, -50%);
        transition: left 0.18s ease-out, top 0.18s ease-out;
        animation: hanzo-cursor-pulse 1.6s ease-in-out infinite;
        opacity: 0;
      }
      .hanzo-ai-cursor.hanzo-visible {
        opacity: 1;
        transition: left 0.18s ease-out, top 0.18s ease-out, opacity 300ms ease;
      }
      @keyframes hanzo-cursor-pulse {
        0%, 100% {
          box-shadow:
            0 0 8px 2px rgba(6, 182, 212, 0.45),
            0 0 24px 6px rgba(6, 182, 212, 0.18);
        }
        50% {
          box-shadow:
            0 0 14px 4px rgba(6, 182, 212, 0.65),
            0 0 36px 10px rgba(6, 182, 212, 0.28);
        }
      }

      /* ---- Cursor trail ---- */
      .hanzo-cursor-trail {
        position: fixed;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: rgba(6, 182, 212, 0.7);
        z-index: 2147483646;
        pointer-events: none;
        transform: translate(-50%, -50%);
        animation: hanzo-trail-fade 0.4s ease-out forwards;
      }
      @keyframes hanzo-trail-fade {
        from { opacity: 0.7; transform: translate(-50%, -50%) scale(1); }
        to { opacity: 0; transform: translate(-50%, -50%) scale(0.15); }
      }

      /* ---- Status banner (top center pill) ---- */
      .hanzo-ai-status {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: 90vw;
        padding: 10px 14px;
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(8, 12, 20, 0.94), rgba(10, 16, 24, 0.96));
        border: 1px solid rgba(56, 189, 248, 0.26);
        color: #f3f4f6;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow:
          0 10px 36px rgba(0, 0, 0, 0.46),
          inset 0 1px 0 rgba(255, 255, 255, 0.08);
        opacity: 0;
        transition: opacity 300ms ease;
        overflow: hidden;
      }
      .hanzo-ai-status::before {
        content: '';
        position: absolute;
        inset: -2px auto -2px -20%;
        width: 40%;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.16), transparent);
        transform: skewX(-18deg);
        animation: hanzo-status-sheen 3.6s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes hanzo-status-sheen {
        0%, 68% { left: -30%; opacity: 0; }
        72% { opacity: 0.4; }
        100% { left: 130%; opacity: 0; }
      }
      .hanzo-ai-status > * {
        position: relative;
      }
      .hanzo-ai-status.hanzo-visible {
        opacity: 1;
      }

      .hanzo-ai-status .hanzo-brand-bubble {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 20px;
        min-width: 30px;
        padding: 0 8px;
        border-radius: 9999px;
        font-size: 10px;
        letter-spacing: 0.25px;
        font-weight: 700;
        text-transform: uppercase;
        color: #e0f2fe;
        background: linear-gradient(180deg, rgba(14, 116, 144, 0.95), rgba(15, 23, 42, 0.95));
        border: 1px solid rgba(56, 189, 248, 0.35);
      }

      .hanzo-ai-status .hanzo-pulse-dot {
        width: 8px;
        height: 8px;
        border-radius: 9999px;
        background: #06b6d4;
        animation: hanzo-dot-pulse 1.4s ease-in-out infinite;
      }
      @keyframes hanzo-dot-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .hanzo-ai-status .hanzo-label {
        max-width: 46vw;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hanzo-ai-status .hanzo-dots::after {
        content: '';
        animation: hanzo-animated-dots 1.5s steps(4) infinite;
      }
      @keyframes hanzo-animated-dots {
        0% { content: ''; }
        25% { content: '.'; }
        50% { content: '..'; }
        75% { content: '...'; }
      }

      .hanzo-ai-status .hanzo-stop-btn {
        border: 1px solid rgba(255, 255, 255, 0.24);
        background: rgba(0, 0, 0, 0.18);
        color: #f8fafc;
        border-radius: 10px;
        padding: 4px 12px;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .hanzo-ai-status .hanzo-stop-btn:hover {
        background: rgba(220, 38, 38, 0.28);
        border-color: rgba(248, 113, 113, 0.6);
      }

      /* ---- "Take Back Control" button (bottom-right) ---- */
      .hanzo-ai-cancel {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        padding: 12px 24px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(15, 18, 24, 0.95);
        color: #f3f4f6;
        font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        pointer-events: auto;
        opacity: 0;
        transition: opacity 300ms ease, background 0.15s;
      }
      .hanzo-ai-cancel.hanzo-visible {
        opacity: 1;
      }
      .hanzo-ai-cancel:hover {
        background: rgba(220, 38, 38, 0.35);
        border-color: rgba(220, 38, 38, 0.5);
      }

      /* ---- Element highlight ---- */
      .hanzo-ai-highlight {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        border: 2px solid rgba(6, 182, 212, 0.85);
        border-radius: 6px;
        box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.15);
        transition: left 0.15s, top 0.15s, width 0.15s, height 0.15s;
      }
    `;
    document.head.appendChild(style);
  }

  function isOverlayElement(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false;
    return !!(
      overlay?.contains(target) ||
      statusEl?.contains(target) ||
      cancelBtn?.contains(target) ||
      cursor?.contains(target) ||
      highlightEl?.contains(target)
    );
  }

  function blockInteraction(event: Event): void {
    if (!interactionBlockActive) return;

    if (event instanceof KeyboardEvent && event.key === 'Escape') {
      chrome.runtime.sendMessage({ action: 'ai.control.cancel' });
      hide();
      return;
    }

    if (isOverlayElement(event.target)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function setInteractionBlock(active: boolean): void {
    if (interactionBlockActive === active) return;

    interactionBlockActive = active;
    for (const eventName of BLOCKED_EVENTS) {
      if (active) {
        document.addEventListener(eventName, blockInteraction, true);
      } else {
        document.removeEventListener(eventName, blockInteraction, true);
      }
    }
  }

  function show(task: string) {
    if (overlay) hide();

    injectStyles();
    setInteractionBlock(true);

    // Backdrop
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    document.body.appendChild(overlay);

    // Cursor
    cursor = document.createElement('div');
    cursor.className = 'hanzo-ai-cursor';
    cursor.style.left = `${window.innerWidth / 2}px`;
    cursor.style.top = `${window.innerHeight / 2}px`;
    document.body.appendChild(cursor);

    // Status banner
    statusEl = document.createElement('div');
    statusEl.className = 'hanzo-ai-status';
    statusEl.innerHTML = `
      <span class="hanzo-brand-bubble">AI</span>
      <div class="hanzo-pulse-dot"></div>
      <span class="hanzo-label">${escapeHtml(task || 'Hanzo AI is controlling this tab')}</span><span class="hanzo-dots"></span>
      <button class="hanzo-stop-btn">Stop</button>
    `;
    document.body.appendChild(statusEl);

    statusEl.querySelector('.hanzo-stop-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'ai.control.cancel' });
      hide();
    });

    // "Take Back Control" button
    cancelBtn = document.createElement('button');
    cancelBtn.className = 'hanzo-ai-cancel';
    cancelBtn.textContent = 'Take Back Control';
    cancelBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'ai.control.cancel' });
      hide();
    });
    document.body.appendChild(cancelBtn);

    // Fade in (next frame so the transition triggers)
    requestAnimationFrame(() => {
      overlay?.classList.add('hanzo-visible');
      cursor?.classList.add('hanzo-visible');
      statusEl?.classList.add('hanzo-visible');
      cancelBtn?.classList.add('hanzo-visible');
    });
  }

  function hide() {
    // Fade out
    overlay?.classList.remove('hanzo-visible');
    cursor?.classList.remove('hanzo-visible');
    statusEl?.classList.remove('hanzo-visible');
    cancelBtn?.classList.remove('hanzo-visible');

    // Remove after transition
    const refs = { overlay, cursor, statusEl, cancelBtn, highlightEl };
    const trails = [...trailNodes];

    setTimeout(() => {
      refs.overlay?.remove();
      refs.cursor?.remove();
      refs.statusEl?.remove();
      refs.cancelBtn?.remove();
      refs.highlightEl?.remove();
      for (const node of trails) {
        node.remove();
      }
    }, 320);

    setInteractionBlock(false);

    overlay = null;
    cursor = null;
    statusEl = null;
    cancelBtn = null;
    highlightEl = null;
    trailNodes = [];
  }

  function moveCursor(x: number, y: number) {
    if (!cursor) return;

    const clampedX = Math.max(0, Math.min(window.innerWidth, Number.isFinite(x) ? x : 0));
    const clampedY = Math.max(0, Math.min(window.innerHeight, Number.isFinite(y) ? y : 0));

    // Trail dot
    const trail = document.createElement('div');
    trail.className = 'hanzo-cursor-trail';
    trail.style.left = `${clampedX}px`;
    trail.style.top = `${clampedY}px`;
    document.body.appendChild(trail);
    trailNodes.push(trail);

    setTimeout(() => {
      trail.remove();
      trailNodes = trailNodes.filter((node) => node !== trail);
    }, 400);

    while (trailNodes.length > 10) {
      trailNodes.shift()?.remove();
    }

    cursor.style.left = `${clampedX}px`;
    cursor.style.top = `${clampedY}px`;
  }

  function highlight(selector: string) {
    highlightEl?.remove();
    highlightEl = null;

    if (!selector || typeof selector !== 'string') return;

    try {
      const target = document.querySelector(selector);
      if (!target) return;

      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      highlightEl = document.createElement('div');
      highlightEl.className = 'hanzo-ai-highlight';
      highlightEl.style.left = `${Math.max(0, rect.left - 4)}px`;
      highlightEl.style.top = `${Math.max(0, rect.top - 4)}px`;
      highlightEl.style.width = `${rect.width + 8}px`;
      highlightEl.style.height = `${rect.height + 8}px`;
      document.body.appendChild(highlightEl);
    } catch {
      // Ignore invalid selectors.
    }
  }

  function updateStatus(text: string) {
    if (!statusEl) return;

    const label = statusEl.querySelector('.hanzo-label');
    if (label) {
      label.textContent = text || 'Hanzo AI is controlling this tab';
    }
  }

  function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return { show, hide, moveCursor, highlight, updateStatus };
})();

type OverlayChatRole = 'user' | 'assistant' | 'system';

interface OverlayChatMessage {
  role: OverlayChatRole;
  content: string;
}

interface OverlayElementContext {
  selector: string;
  tag: string;
  text: string;
  html: string;
}

class HanzoPageOverlay {
  private mounted = false;
  private enabled = false;
  private open = false;
  private sending = false;
  private watchMode = false;
  private editMode = false;
  private modelsLoaded = false;
  private messages: OverlayChatMessage[] = [];
  private selectedContext: OverlayElementContext | null = null;
  private hoveredElement: HTMLElement | null = null;
  private editingElement: HTMLElement | null = null;

  private root: HTMLDivElement | null = null;
  private launcher: HTMLButtonElement | null = null;
  private panel: HTMLDivElement | null = null;
  private messagesEl: HTMLDivElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private modelEl: HTMLSelectElement | null = null;
  private contextEl: HTMLDivElement | null = null;
  private watchBtn: HTMLButtonElement | null = null;
  private editBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLSpanElement | null = null;
  private highlightBox: HTMLDivElement | null = null;

  constructor() {
    this.injectStyles();
    this.mount();
    this.bindGlobalEvents();
  }

  toggle(): boolean {
    if (!this.enabled || !this.open) {
      this.show();
      return true;
    }
    this.hide();
    return false;
  }

  show(): void {
    this.ensureMounted();
    this.enabled = true;
    this.open = true;
    this.root?.setAttribute('data-enabled', 'true');
    this.root?.setAttribute('data-open', 'true');
    this.loadModels();
    this.focusInput();
  }

  hide(): void {
    this.open = false;
    this.root?.setAttribute('data-open', 'false');
    this.updateStatus('');
    this.clearHighlight();
    this.setWatchMode(false);
    this.setEditMode(false);
  }

  isOpen(): boolean {
    return this.open;
  }

  private ensureMounted(): void {
    if (this.mounted) return;
    this.mount();
  }

  private injectStyles(): void {
    if (document.getElementById('hanzo-page-overlay-styles')) return;

    const style = document.createElement('style');
    style.id = 'hanzo-page-overlay-styles';
    style.textContent = `
      #hanzo-page-overlay-root {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483645;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        pointer-events: none;
      }

      #hanzo-page-overlay-root * {
        box-sizing: border-box;
      }

      #hanzo-page-overlay-root[data-enabled="false"] .hanzo-page-launcher {
        opacity: 0;
        transform: translateY(16px);
        pointer-events: none;
      }

      .hanzo-page-launcher {
        width: 54px;
        height: 54px;
        border-radius: 9999px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: linear-gradient(135deg, rgba(22, 24, 31, 0.96), rgba(7, 8, 12, 0.96));
        color: #ffffff;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        pointer-events: auto;
        transition: transform 0.2s ease, opacity 0.2s ease;
      }

      .hanzo-page-launcher:hover {
        transform: translateY(-2px);
      }

      .hanzo-page-panel {
        width: min(420px, calc(100vw - 24px));
        max-height: min(620px, calc(100vh - 28px));
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: linear-gradient(180deg, rgba(11, 13, 18, 0.97), rgba(7, 8, 12, 0.97));
        color: #eef2ff;
        overflow: hidden;
        box-shadow: 0 22px 48px rgba(0, 0, 0, 0.45);
        transform-origin: bottom right;
        transform: translateY(8px) scale(0.98);
        opacity: 0;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        margin-bottom: 10px;
        transition: transform 0.18s ease, opacity 0.18s ease;
      }

      #hanzo-page-overlay-root[data-open="true"] .hanzo-page-panel {
        transform: translateY(0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }

      #hanzo-page-overlay-root[data-open="true"] .hanzo-page-launcher {
        opacity: 0;
        transform: scale(0.9);
        pointer-events: none;
      }

      .hanzo-page-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent);
      }

      .hanzo-page-brand {
        font-weight: 700;
        letter-spacing: 0.2px;
        font-size: 13px;
      }

      .hanzo-page-header-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .hanzo-chip-btn {
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 9999px;
        padding: 4px 10px;
        background: rgba(255, 255, 255, 0.02);
        color: #d6deff;
        cursor: pointer;
        font-size: 11px;
      }

      .hanzo-chip-btn[data-active="true"] {
        border-color: rgba(56, 189, 248, 0.62);
        background: rgba(14, 116, 144, 0.3);
        color: #e0f2fe;
      }

      .hanzo-icon-btn {
        width: 28px;
        height: 28px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: transparent;
        color: #e5e7eb;
        cursor: pointer;
        font-size: 16px;
      }

      .hanzo-page-meta {
        padding: 10px 14px 6px 14px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
      }

      .hanzo-page-context {
        font-size: 11px;
        color: #a5b4fc;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hanzo-page-status {
        font-size: 11px;
        color: #93c5fd;
      }

      .hanzo-model-row {
        padding: 0 14px 8px 14px;
      }

      .hanzo-model-row select {
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.03);
        color: #f1f5f9;
        padding: 7px 9px;
        font-size: 12px;
      }

      .hanzo-page-messages {
        flex: 1;
        min-height: 200px;
        max-height: 370px;
        overflow-y: auto;
        padding: 8px 14px 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .hanzo-page-msg {
        padding: 9px 10px;
        border-radius: 10px;
        font-size: 12px;
        line-height: 1.45;
        word-break: break-word;
      }

      .hanzo-page-msg.user {
        align-self: flex-end;
        max-width: 88%;
        background: rgba(59, 130, 246, 0.2);
        border: 1px solid rgba(59, 130, 246, 0.4);
      }

      .hanzo-page-msg.assistant {
        align-self: flex-start;
        max-width: 92%;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      .hanzo-page-composer {
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        padding: 10px 12px;
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }

      .hanzo-page-composer textarea {
        flex: 1;
        min-height: 38px;
        max-height: 110px;
        resize: none;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.17);
        background: rgba(255, 255, 255, 0.03);
        color: #f8fafc;
        padding: 9px 11px;
        font-size: 12px;
      }

      .hanzo-page-composer button {
        min-width: 68px;
        height: 38px;
        border-radius: 10px;
        border: 1px solid rgba(37, 99, 235, 0.65);
        background: linear-gradient(180deg, rgba(37, 99, 235, 0.95), rgba(30, 64, 175, 0.95));
        color: #eff6ff;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
      }

      .hanzo-page-composer button:disabled {
        opacity: 0.55;
        cursor: default;
      }

      .hanzo-page-highlight {
        position: fixed;
        z-index: 2147483644;
        pointer-events: none;
        border: 2px solid rgba(56, 189, 248, 0.95);
        border-radius: 6px;
        box-shadow: 0 0 0 2px rgba(14, 116, 144, 0.2);
      }

      [data-hanzo-inline-editing="true"] {
        outline: 2px solid rgba(251, 191, 36, 0.92) !important;
        outline-offset: 2px !important;
      }
    `;
    document.head.appendChild(style);
  }

  private mount(): void {
    if (this.mounted) return;

    this.root = document.createElement('div');
    this.root.id = 'hanzo-page-overlay-root';
    this.root.setAttribute('data-open', 'false');
    this.root.setAttribute('data-enabled', 'false');
    this.root.innerHTML = `
      <div class="hanzo-page-panel" role="dialog" aria-label="Hanzo Page Assistant">
        <div class="hanzo-page-header">
          <div class="hanzo-page-brand">Hanzo Overlay</div>
          <div class="hanzo-page-header-actions">
            <button class="hanzo-chip-btn" data-role="watch" data-active="false" title="Watch elements on hover">Watch</button>
            <button class="hanzo-chip-btn" data-role="edit" data-active="false" title="Click any element to edit text">Edit</button>
            <button class="hanzo-icon-btn" data-role="close" title="Minimize">×</button>
          </div>
        </div>
        <div class="hanzo-page-meta">
          <div class="hanzo-page-context">Use Watch to inspect page elements.</div>
          <span class="hanzo-page-status"></span>
        </div>
        <div class="hanzo-model-row">
          <select data-role="model">
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-opus-4-20250514">Claude Opus 4</option>
            <option value="gpt-4o">GPT-4o</option>
            <option value="zen-coder-flash">Zen Coder Flash</option>
            <option value="zen-max">Zen Max</option>
          </select>
        </div>
        <div class="hanzo-page-messages" data-role="messages">
          <div class="hanzo-page-msg assistant">Ask about this page, inspect any element, or turn on Edit mode to change text in-place.</div>
        </div>
        <div class="hanzo-page-composer">
          <textarea data-role="input" rows="1" placeholder="Ask about this page..."></textarea>
          <button data-role="send" type="button">Ask</button>
        </div>
      </div>
      <button class="hanzo-page-launcher" data-role="launcher" type="button" title="Open Hanzo Overlay">AI</button>
    `;

    this.panel = this.root.querySelector('.hanzo-page-panel');
    this.launcher = this.root.querySelector('[data-role="launcher"]');
    this.messagesEl = this.root.querySelector('[data-role="messages"]');
    this.inputEl = this.root.querySelector('[data-role="input"]');
    this.sendBtn = this.root.querySelector('[data-role="send"]');
    this.modelEl = this.root.querySelector('[data-role="model"]');
    this.contextEl = this.root.querySelector('.hanzo-page-context');
    this.watchBtn = this.root.querySelector('[data-role="watch"]');
    this.editBtn = this.root.querySelector('[data-role="edit"]');
    this.statusEl = this.root.querySelector('.hanzo-page-status');

    this.launcher?.addEventListener('click', () => this.show());
    this.root.querySelector('[data-role="close"]')?.addEventListener('click', () => this.hide());
    this.watchBtn?.addEventListener('click', () => this.setWatchMode(!this.watchMode));
    this.editBtn?.addEventListener('click', () => this.setEditMode(!this.editMode));
    this.sendBtn?.addEventListener('click', () => this.askPageQuestion());
    this.inputEl?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.askPageQuestion();
      }
    });
    this.inputEl?.addEventListener('input', () => {
      if (!this.inputEl) return;
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 110)}px`;
    });

    document.documentElement.appendChild(this.root);
    this.mounted = true;
  }

  private bindGlobalEvents(): void {
    document.addEventListener('mousemove', (event) => this.onMouseMove(event), true);
    document.addEventListener('click', (event) => this.onDocumentClick(event), true);
    document.addEventListener('keydown', (event) => this.onKeyDown(event), true);
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.watchMode) return;
    const target = this.getPageTarget(event.target);
    if (!target) return;
    this.hoveredElement = target;
    this.showHighlight(target);
    if (!this.selectedContext) {
      this.contextEl && (this.contextEl.textContent = this.getElementSummary(target));
    }
  }

  private onDocumentClick(event: MouseEvent): void {
    if (!this.watchMode && !this.editMode) return;
    const target = this.getPageTarget(event.target);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (this.watchMode) {
      this.selectedContext = this.captureElementContext(target);
      this.contextEl && (this.contextEl.textContent = this.getElementSummary(target));
      this.updateStatus('Element selected');
    }

    if (this.editMode) {
      this.enableInlineEdit(target);
      this.updateStatus('Editing element');
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.editingElement) {
        this.disableInlineEdit(this.editingElement, false);
        this.updateStatus('Edit canceled');
        event.preventDefault();
        return;
      }
      if (this.open) {
        this.hide();
        event.preventDefault();
      }
    }
  }

  private getPageTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    if (this.root?.contains(target)) return null;
    if (!target.isConnected) return null;
    if (target.tagName.toLowerCase() === 'html' || target.tagName.toLowerCase() === 'body') return null;
    return target;
  }

  private setWatchMode(active: boolean): void {
    this.watchMode = active;
    if (active) this.setEditMode(false);
    this.watchBtn?.setAttribute('data-active', active ? 'true' : 'false');
    if (!active) {
      this.hoveredElement = null;
      this.clearHighlight();
      if (!this.selectedContext && this.contextEl) {
        this.contextEl.textContent = 'Use Watch to inspect page elements.';
      }
    } else {
      this.updateStatus('Watch mode on');
    }
  }

  private setEditMode(active: boolean): void {
    this.editMode = active;
    if (active) this.setWatchMode(false);
    this.editBtn?.setAttribute('data-active', active ? 'true' : 'false');
    if (!active && this.editingElement) {
      this.disableInlineEdit(this.editingElement, true);
    } else if (active) {
      this.updateStatus('Edit mode on');
    }
  }

  private enableInlineEdit(element: HTMLElement): void {
    if (this.editingElement && this.editingElement !== element) {
      this.disableInlineEdit(this.editingElement, true);
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      this.editingElement = element;
      return;
    }

    if (!element.hasAttribute('data-hanzo-original-html')) {
      element.setAttribute('data-hanzo-original-html', element.innerHTML);
    }
    element.setAttribute('contenteditable', 'true');
    element.setAttribute('spellcheck', 'true');
    element.setAttribute('data-hanzo-inline-editing', 'true');
    element.focus();
    this.editingElement = element;

    const keydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.disableInlineEdit(element, false);
        this.updateStatus('Edit reverted');
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.disableInlineEdit(element, true);
        this.updateStatus('Edit applied');
      }
    };

    const blurHandler = () => {
      this.disableInlineEdit(element, true);
      this.updateStatus('Edit applied');
    };

    element.addEventListener('keydown', keydownHandler, { once: true });
    element.addEventListener('blur', blurHandler, { once: true });
  }

  private disableInlineEdit(element: HTMLElement, keepChanges: boolean): void {
    if (!keepChanges) {
      const original = element.getAttribute('data-hanzo-original-html');
      if (original !== null) {
        element.innerHTML = original;
      }
    }

    element.removeAttribute('contenteditable');
    element.removeAttribute('spellcheck');
    element.removeAttribute('data-hanzo-inline-editing');
    element.removeAttribute('data-hanzo-original-html');

    if (this.editingElement === element) {
      this.editingElement = null;
    }
  }

  private showHighlight(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.clearHighlight();
      return;
    }

    if (!this.highlightBox) {
      this.highlightBox = document.createElement('div');
      this.highlightBox.className = 'hanzo-page-highlight';
      document.documentElement.appendChild(this.highlightBox);
    }

    this.highlightBox.style.left = `${Math.max(0, rect.left - 3)}px`;
    this.highlightBox.style.top = `${Math.max(0, rect.top - 3)}px`;
    this.highlightBox.style.width = `${rect.width + 6}px`;
    this.highlightBox.style.height = `${rect.height + 6}px`;
  }

  private clearHighlight(): void {
    this.highlightBox?.remove();
    this.highlightBox = null;
  }

  private captureElementContext(element: HTMLElement): OverlayElementContext {
    const text = this.normalizeText(element.innerText || element.textContent || '');
    return {
      selector: this.buildSelector(element),
      tag: element.tagName.toLowerCase(),
      text: text.slice(0, 800),
      html: element.outerHTML.slice(0, 1200),
    };
  }

  private buildSelector(element: HTMLElement): string {
    if (element.id) return `#${element.id}`;

    const parts: string[] = [];
    let current: HTMLElement | null = element;
    let depth = 0;

    while (current && depth < 6) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length > 0) {
        const className = Array.from(current.classList).slice(0, 2).join('.');
        if (className) part += `.${className}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((node) => node.tagName === current!.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(part);
      current = parent;
      depth += 1;
    }

    return parts.join(' > ');
  }

  private normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private getElementSummary(element: HTMLElement): string {
    const ctx = this.captureElementContext(element);
    return `${ctx.tag} • ${ctx.selector}`;
  }

  private async loadModels(): Promise<void> {
    if (this.modelsLoaded || !this.modelEl) return;

    try {
      const response = await chrome.runtime.sendMessage({ action: 'chat.listModels' });
      if (!response?.success || !Array.isArray(response.models) || !response.models.length) {
        return;
      }

      const previous = this.modelEl.value;
      this.modelEl.innerHTML = '';
      for (const model of response.models) {
        if (!model?.id) continue;
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name || model.id;
        this.modelEl.appendChild(option);
      }
      if (previous && Array.from(this.modelEl.options).some((opt) => opt.value === previous)) {
        this.modelEl.value = previous;
      }
      this.modelsLoaded = true;
    } catch {
      // Keep local defaults if model fetch fails.
    }
  }

  private focusInput(): void {
    if (!this.inputEl) return;
    this.inputEl.focus();
  }

  private appendMessage(role: 'user' | 'assistant', content: string): void {
    if (!this.messagesEl) return;
    const div = document.createElement('div');
    div.className = `hanzo-page-msg ${role}`;
    div.textContent = content;
    this.messagesEl.appendChild(div);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private updateStatus(text: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
  }

  private buildPageContext(): string {
    const selection = this.normalizeText(window.getSelection?.()?.toString() || '');
    const contextLines = [
      `URL: ${location.href}`,
      `Title: ${document.title || 'Untitled'}`,
    ];

    if (selection) {
      contextLines.push(`TextSelection: ${selection.slice(0, 600)}`);
    }

    const elementContext = this.selectedContext || (this.hoveredElement ? this.captureElementContext(this.hoveredElement) : null);
    if (elementContext) {
      contextLines.push(`ElementSelector: ${elementContext.selector}`);
      if (elementContext.text) contextLines.push(`ElementText: ${elementContext.text.slice(0, 600)}`);
      contextLines.push(`ElementHTML: ${elementContext.html.slice(0, 800)}`);
    }

    return contextLines.join('\n');
  }

  private async askPageQuestion(): Promise<void> {
    if (this.sending || !this.inputEl) return;

    const prompt = this.normalizeText(this.inputEl.value);
    if (!prompt) return;

    const tokenResp = await chrome.runtime.sendMessage({ action: 'auth.getToken' });
    if (!tokenResp?.success || !tokenResp.token) {
      this.appendMessage('assistant', 'Please sign in from the Hanzo sidebar/popup before using page chat.');
      return;
    }

    this.sending = true;
    this.updateStatus('Thinking...');
    this.sendBtn && (this.sendBtn.disabled = true);

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.appendMessage('user', prompt);

    const systemContext = this.buildPageContext();
    const model = this.modelEl?.value || 'gpt-4o';
    const requestMessages: OverlayChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are Hanzo page overlay assistant.',
          'Use provided page context and selected element context when relevant.',
          'Be concise and provide concrete UI or DOM edit suggestions when asked.',
          '',
          systemContext,
        ].join('\n'),
      },
      ...this.messages.slice(-8),
      { role: 'user', content: prompt },
    ];

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'chat.complete',
        model,
        messages: requestMessages,
      });

      if (!response?.success || !response.content) {
        throw new Error(response?.error || 'No response from chat service');
      }

      const answer = String(response.content).trim();
      this.appendMessage('assistant', answer || 'No response content.');
      this.messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: answer });
      this.messages = this.messages.slice(-20);
      this.updateStatus('Ready');
    } catch (error: any) {
      this.appendMessage('assistant', `Error: ${error?.message || 'Chat request failed'}`);
      this.updateStatus('Error');
    } finally {
      this.sending = false;
      this.sendBtn && (this.sendBtn.disabled = false);
      this.focusInput();
    }
  }
}

const pageOverlay = new HanzoPageOverlay();

// Initialize
new HanzoContentScript();
