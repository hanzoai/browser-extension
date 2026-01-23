// Server-side Framework Support for Browser Extension
// Detects and extracts source information from Rails, Django, Flask, etc.

interface ServerFrameworkInfo {
  framework: string;
  file?: string;
  line?: number;
  controller?: string;
  action?: string;
  template?: string;
}

export class ServerFrameworkDetector {
  
  // Rails detection and extraction
  detectRails(element: HTMLElement): ServerFrameworkInfo | null {
    // Rails adds data attributes in development
    const railsData = {
      controller: element.getAttribute('data-controller'),
      action: element.getAttribute('data-action'),
      turboFrame: element.getAttribute('data-turbo-frame'),
      // Rails 7+ with Stimulus
      stimulusController: element.getAttribute('data-controller'),
      // ViewComponent data
      viewComponent: element.getAttribute('data-view-component'),
      viewComponentPath: element.getAttribute('data-view-component-path')
    };
    
    // Check for Rails-specific meta tags
    const csrfToken = document.querySelector('meta[name="csrf-token"]');
    const railsEnv = document.querySelector('meta[name="rails-env"]');
    
    if (csrfToken || railsEnv || Object.values(railsData).some(v => v)) {
      // Look for Rails stack trace comments in development
      const comments = this.extractHTMLComments(element);
      const templateMatch = comments.find(c => c.includes('BEGIN') && c.includes('app/views'));
      
      if (templateMatch) {
        // Extract template path from comment
        // <!-- BEGIN app/views/posts/show.html.erb -->
        const match = templateMatch.match(/BEGIN\s+(app\/views\/[^\s]+)/);
        if (match) {
          return {
            framework: 'rails',
            template: match[1],
            controller: railsData.controller || this.extractRailsController(match[1]),
            action: railsData.action || this.extractRailsAction(match[1])
          };
        }
      }
      
      // Fallback to data attributes
      if (railsData.viewComponentPath) {
        return {
          framework: 'rails-viewcomponent',
          file: railsData.viewComponentPath,
          controller: railsData.viewComponent
        };
      }
      
      return {
        framework: 'rails',
        controller: railsData.controller || railsData.stimulusController,
        action: railsData.action
      };
    }
    
    return null;
  }
  
  // Django detection and extraction
  detectDjango(element: HTMLElement): ServerFrameworkInfo | null {
    // Django Debug Toolbar adds data
    const djangoDebug = document.getElementById('djDebug');
    
    // Django templates in debug mode often have comments
    const comments = this.extractHTMLComments(element);
    const djangoTemplate = comments.find(c => 
      c.includes('TEMPLATE_DEBUG') || 
      c.includes('templates/') ||
      c.includes('{% block')
    );
    
    // Django CMS specific
    const djangoCMS = element.getAttribute('data-cms-plugin');
    
    // Django REST Framework
    const djangoREST = document.querySelector('meta[name="generator"][content*="Django REST"]');
    
    if (djangoDebug || djangoTemplate || djangoCMS || djangoREST) {
      // Extract template info from comments
      // <!-- BEGIN: templates/blog/post_detail.html -->
      const templateMatch = djangoTemplate?.match(/templates\/([^\s]+)/);
      
      // Extract view info from Django debug
      if (djangoDebug) {
        const viewInfo = this.extractDjangoViewInfo();
        return {
          framework: 'django',
          file: viewInfo.file,
          line: viewInfo.line,
          template: templateMatch?.[1]
        };
      }
      
      return {
        framework: 'django',
        template: templateMatch?.[1],
        controller: djangoCMS
      };
    }
    
    return null;
  }
  
  // Flask detection and extraction
  detectFlask(element: HTMLElement): ServerFrameworkInfo | null {
    // Flask debug mode adds specific classes
    const flaskDebugger = document.querySelector('.flask-debugger');
    const werkzeugDebugger = document.querySelector('#werkzeug-debugger');
    
    // Flask often uses Jinja2 templates
    const comments = this.extractHTMLComments(element);
    const jinjaTemplate = comments.find(c => 
      c.includes('{%') || 
      c.includes('{{') ||
      c.includes('templates/')
    );
    
    // Flask-Admin specific
    const flaskAdmin = document.querySelector('meta[name="generator"][content*="Flask-Admin"]');
    
    if (flaskDebugger || werkzeugDebugger || jinjaTemplate || flaskAdmin) {
      // Extract template from comments
      // <!-- Template: templates/user/profile.html -->
      const templateMatch = jinjaTemplate?.match(/[Tt]emplate:\s*([^\s]+)/);
      
      // Extract route from Flask debugger
      const routeInfo = this.extractFlaskRouteInfo(element);
      
      return {
        framework: 'flask',
        template: templateMatch?.[1],
        controller: routeInfo.blueprint,
        action: routeInfo.endpoint,
        file: routeInfo.file,
        line: routeInfo.line
      };
    }
    
    return null;
  }
  
  // Laravel detection
  detectLaravel(element: HTMLElement): ServerFrameworkInfo | null {
    // Laravel adds specific meta tags and comments
    const laravelToken = document.querySelector('meta[name="csrf-token"]');
    const laravelDebugbar = document.querySelector('.phpdebugbar');
    
    // Blade template comments
    const comments = this.extractHTMLComments(element);
    const bladeTemplate = comments.find(c => 
      c.includes('resources/views/') ||
      c.includes('@extends') ||
      c.includes('@section')
    );
    
    if ((laravelToken && bladeTemplate) || laravelDebugbar) {
      // Extract Blade template path
      const templateMatch = bladeTemplate?.match(/resources\/views\/([^\s]+)/);
      
      return {
        framework: 'laravel',
        template: templateMatch?.[1]?.replace(/\.blade\.php$/, '').replace(/\./g, '/') + '.blade.php',
        controller: element.getAttribute('data-controller'),
        action: element.getAttribute('data-action')
      };
    }
    
    return null;
  }
  
  // Phoenix/Elixir detection
  detectPhoenix(element: HTMLElement): ServerFrameworkInfo | null {
    // Phoenix LiveView specific
    const phxMain = document.querySelector('[data-phx-main]');
    const phxSession = element.getAttribute('data-phx-session');
    const phxStatic = element.getAttribute('data-phx-static');
    
    if (phxMain || phxSession || phxStatic) {
      // Phoenix adds source info in dev
      const phxView = element.getAttribute('data-phx-view');
      const phxComponent = element.closest('[data-phx-component]')?.getAttribute('data-phx-component');
      
      return {
        framework: 'phoenix',
        controller: phxView || phxComponent,
        template: element.getAttribute('data-phx-template')
      };
    }
    
    return null;
  }
  
  // ASP.NET Core detection
  detectASPNET(element: HTMLElement): ServerFrameworkInfo | null {
    // ASP.NET Core tag helpers
    const aspAction = element.getAttribute('asp-action');
    const aspController = element.getAttribute('asp-controller');
    const aspPage = element.getAttribute('asp-page');
    
    // Blazor components
    const blazorComponent = element.getAttribute('b-component');
    
    if (aspAction || aspController || aspPage || blazorComponent) {
      return {
        framework: blazorComponent ? 'blazor' : 'aspnet',
        controller: aspController || blazorComponent,
        action: aspAction,
        template: aspPage
      };
    }
    
    return null;
  }
  
  // Express.js detection (with template engines)
  detectExpress(element: HTMLElement): ServerFrameworkInfo | null {
    // Common template engine markers
    const comments = this.extractHTMLComments(element);
    
    // Pug/Jade templates
    const pugTemplate = comments.find(c => c.includes('.pug') || c.includes('.jade'));
    
    // EJS templates
    const ejsTemplate = comments.find(c => c.includes('.ejs') || c.includes('<%'));
    
    // Handlebars
    const hbsTemplate = comments.find(c => c.includes('.hbs') || c.includes('{{'));
    
    if (pugTemplate || ejsTemplate || hbsTemplate) {
      const templateMatch = (pugTemplate || ejsTemplate || hbsTemplate)?.match(/views\/([^\s]+)/);
      
      return {
        framework: 'express',
        template: templateMatch?.[1]
      };
    }
    
    return null;
  }
  
  // WordPress detection
  detectWordPress(element: HTMLElement): ServerFrameworkInfo | null {
    // WordPress adds specific classes and meta tags
    const wpHead = document.querySelector('meta[name="generator"][content*="WordPress"]');
    const wpAdmin = document.getElementById('wpadminbar');
    
    // WordPress debug comments
    const comments = this.extractHTMLComments(element);
    const wpTemplate = comments.find(c => 
      c.includes('Template:') || 
      c.includes('wp-content/themes/')
    );
    
    if (wpHead || wpAdmin || wpTemplate) {
      const templateMatch = wpTemplate?.match(/Template:\s*([^\s]+)/);
      const themeMatch = wpTemplate?.match(/themes\/([^\/]+)\/(.+)/);
      
      return {
        framework: 'wordpress',
        template: templateMatch?.[1] || themeMatch?.[2],
        controller: themeMatch?.[1] // theme name
      };
    }
    
    return null;
  }
  
  // Helper methods
  private extractHTMLComments(element: HTMLElement): string[] {
    const comments: string[] = [];
    
    // Simple fallback for test environments - look for comment-like patterns in innerHTML
    const htmlContent = element.innerHTML + (element.parentElement?.innerHTML || '');
    const commentMatches = htmlContent.match(/<!--([^-]|[-][^-])*-->/g);
    if (commentMatches) {
      commentMatches.forEach(match => {
        // Extract content between <!-- and -->
        const content = match.replace(/<!--\s*/, '').replace(/\s*-->/, '');
        comments.push(content);
      });
    }
    
    // Try using TreeWalker if available (browser environment)
    if (typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      try {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_COMMENT,
          null
        );
        
        let node;
        while (node = walker.nextNode()) {
          const content = node.textContent || '';
          if (!comments.includes(content)) {
            comments.push(content);
          }
        }
        
        // Also check parents up to body
        let parent = element.parentElement;
        while (parent && parent !== document.body) {
          const parentWalker = document.createTreeWalker(
            parent,
            NodeFilter.SHOW_COMMENT,
            null
          );
          
          while (node = parentWalker.nextNode()) {
            const content = node.textContent || '';
            if (!comments.includes(content)) {
              comments.push(content);
            }
          }
          
          parent = parent.parentElement;
        }
      } catch (e) {
        // TreeWalker failed, rely on regex fallback
      }
    }
    
    return comments;
  }
  
  private extractRailsController(templatePath: string): string {
    // app/views/posts/show.html.erb -> PostsController
    // app/views/admin/users/index.html.erb -> AdminUsersController
    const match = templatePath.match(/views\/(.+)\//);
    if (match) {
      const parts = match[1].split('/');
      return parts.map(part => 
        part.split('_').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join('')
      ).join('') + 'Controller';
    }
    return '';
  }
  
  private extractRailsAction(templatePath: string): string {
    // app/views/posts/show.html.erb -> show
    const match = templatePath.match(/\/([^\/]+)\.html\./);
    return match?.[1] || '';
  }
  
  private extractDjangoViewInfo(): { file?: string, line?: number } {
    // Try to extract from Django Debug Toolbar
    const toolbar = document.getElementById('djDebugToolbar');
    if (toolbar) {
      // Look for view info in toolbar panels
      const viewPanel = toolbar.querySelector('.djDebugPanelContent .view-info');
      if (viewPanel) {
        const text = viewPanel.textContent || '';
        const fileMatch = text.match(/File:\s*([^\s]+)/);
        const lineMatch = text.match(/Line:\s*(\d+)/);
        
        return {
          file: fileMatch?.[1],
          line: lineMatch ? parseInt(lineMatch[1]) : undefined
        };
      }
    }
    
    return {};
  }
  
  private extractFlaskRouteInfo(element: HTMLElement): { 
    blueprint?: string, 
    endpoint?: string, 
    file?: string, 
    line?: number 
  } {
    // Try to extract from Werkzeug debugger
    const debuggerEl = document.getElementById('werkzeug-debugger');
    if (debuggerEl) {
      const traceback = debuggerEl.querySelector('.traceback');
      if (traceback) {
        const text = traceback.textContent || '';
        
        // Extract endpoint from traceback
        const endpointMatch = text.match(/endpoint:\s*'([^']+)'/);
        const fileMatch = text.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
        
        return {
          endpoint: endpointMatch?.[1],
          file: fileMatch?.[1],
          line: fileMatch ? parseInt(fileMatch[2]) : undefined,
          blueprint: endpointMatch?.[1]?.split('.')[0]
        };
      }
    }
    
    return {};
  }
  
  // Main detection method
  detect(element: HTMLElement): ServerFrameworkInfo | null {
    // Try each framework detector
    const detectors = [
      () => this.detectRails(element),
      () => this.detectDjango(element),
      () => this.detectFlask(element),
      () => this.detectLaravel(element),
      () => this.detectPhoenix(element),
      () => this.detectASPNET(element),
      () => this.detectExpress(element),
      () => this.detectWordPress(element)
    ];
    
    for (const detector of detectors) {
      const result = detector();
      if (result) {
        return result;
      }
    }
    
    return null;
  }
}