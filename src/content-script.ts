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
  private ws: WebSocket | null = null;
  private readonly WS_URL = 'ws://localhost:3001/browser-extension';
  
  constructor() {
    this.connect();
    this.setupClickHandler();
    this.injectHelpers();
  }

  private connect() {
    this.ws = new WebSocket(this.WS_URL);
    this.ws.onopen = () => console.log('[Hanzo] Connected to MCP server');
    this.ws.onerror = () => setTimeout(() => this.connect(), 5000);
    this.ws.onclose = () => setTimeout(() => this.connect(), 5000);
  }

  private setupClickHandler() {
    document.addEventListener('click', (e) => {
      if (!e.altKey || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      
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
        fallbackId: element.getAttribute('data-hanzo-id') || undefined
      };
      
      this.ws.send(JSON.stringify(event));
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
    // Access React DevTools global hook
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return undefined;

    // Find React fiber
    const fiber = this.findReactFiber(element);
    if (!fiber) return undefined;

    // Look for __source in props or _debugSource
    const source = fiber._debugSource || fiber.pendingProps?.__source || fiber.memoizedProps?.__source;
    
    if (source && source.fileName) {
      return {
        file: source.fileName,
        line: source.lineNumber,
        column: source.columnNumber
      };
    }
    
    return undefined;
  }

  private findReactFiber(element: HTMLElement): any {
    const key = Object.keys(element).find(key => 
      key.startsWith('__reactInternalInstance$') || 
      key.startsWith('__reactFiber$')
    );
    return key ? (element as any)[key] : null;
  }

  private extractVueSource(element: HTMLElement): SourceLocation | undefined {
    const hook = (window as any).__VUE_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return undefined;

    // Vue 3
    let instance = (element as any).__vueParentComponent;
    
    // Vue 2 fallback
    if (!instance) {
      instance = (element as any).__vue__;
    }
    
    if (instance?.type?.__file) {
      const location: SourceLocation = {
        file: instance.type.__file,
        line: 1 // Vue doesn't expose line by default
      };
      
      // Try to get line from vnode loc
      if (instance.vnode?.loc) {
        location.line = instance.vnode.loc.start.line;
        location.column = instance.vnode.loc.start.column;
      }
      
      return location;
    }
    
    return undefined;
  }

  private extractSvelteSource(element: HTMLElement): SourceLocation | undefined {
    // Svelte stores source in $$_location
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
    // Inject CSS for visual feedback
    const style = document.createElement('style');
    style.textContent = `
      [data-hanzo-hover] {
        outline: 2px dashed #ff6b6b !important;
        outline-offset: 2px !important;
      }
    `;
    document.head.appendChild(style);

    // Add hover effect on Alt key
    document.addEventListener('mousemove', (e) => {
      document.querySelectorAll('[data-hanzo-hover]').forEach(el => {
        el.removeAttribute('data-hanzo-hover');
      });
      
      if (e.altKey && e.target instanceof HTMLElement) {
        e.target.setAttribute('data-hanzo-hover', 'true');
      }
    });
  }
}

// Initialize
new HanzoContentScript();