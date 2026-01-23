import { describe, it, expect, beforeEach } from 'vitest';
import { ServerFrameworkDetector } from '../src/server-frameworks';
import { JSDOM } from 'jsdom';

describe('Server Framework Detection', () => {
  let detector: ServerFrameworkDetector;
  let dom: JSDOM;
  let document: Document;
  
  beforeEach(() => {
    detector = new ServerFrameworkDetector();
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    document = dom.window.document;
    // @ts-ignore
    global.document = document;
  });
  
  describe('Rails detection', () => {
    it('should detect Rails via CSRF token', () => {
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const element = document.createElement('div');
      element.setAttribute('data-controller', 'posts');
      element.setAttribute('data-action', 'show');
      
      const result = detector.detectRails(element);
      
      expect(result).toMatchObject({
        framework: 'rails',
        controller: 'posts',
        action: 'show'
      });
    });
    
    it('should detect Rails ViewComponent', () => {
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const element = document.createElement('div');
      element.setAttribute('data-view-component', 'ButtonComponent');
      element.setAttribute('data-view-component-path', 'app/components/button_component.rb');
      
      const result = detector.detectRails(element);
      
      expect(result).toMatchObject({
        framework: 'rails-viewcomponent',
        file: 'app/components/button_component.rb',
        controller: 'ButtonComponent'
      });
    });
    
    it('should extract Rails template from comments', () => {
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const element = document.createElement('div');
      element.innerHTML = '<!-- BEGIN app/views/posts/show.html.erb --><p>Content</p>';
      
      const result = detector.detectRails(element);
      
      expect(result).toMatchObject({
        framework: 'rails',
        template: 'app/views/posts/show.html.erb',
        controller: 'PostsController',
        action: 'show'
      });
    });
  });
  
  describe('Django detection', () => {
    it('should detect Django Debug Toolbar', () => {
      const debugEl = document.createElement('div');
      debugEl.id = 'djDebug';
      document.body.appendChild(debugEl);
      
      const element = document.createElement('div');
      
      const result = detector.detectDjango(element);
      
      expect(result).toMatchObject({
        framework: 'django'
      });
    });
    
    it('should detect Django templates from comments', () => {
      const element = document.createElement('div');
      element.innerHTML = '<!-- TEMPLATE_DEBUG: templates/blog/post_detail.html --><p>Content</p>';
      
      const result = detector.detectDjango(element);
      
      expect(result).toMatchObject({
        framework: 'django',
        template: 'blog/post_detail.html'
      });
    });
    
    it('should detect Django CMS plugins', () => {
      const element = document.createElement('div');
      element.setAttribute('data-cms-plugin', 'TextPlugin');
      
      const result = detector.detectDjango(element);
      
      expect(result).toMatchObject({
        framework: 'django',
        controller: 'TextPlugin'
      });
    });
  });
  
  describe('Flask detection', () => {
    it('should detect Flask debug mode', () => {
      const debugEl = document.createElement('div');
      debugEl.className = 'flask-debugger';
      document.body.appendChild(debugEl);
      
      const element = document.createElement('div');
      
      const result = detector.detectFlask(element);
      
      expect(result).toMatchObject({
        framework: 'flask'
      });
    });
    
    it('should detect Werkzeug debugger', () => {
      const debugEl = document.createElement('div');
      debugEl.id = 'werkzeug-debugger';
      document.body.appendChild(debugEl);
      
      const element = document.createElement('div');
      
      const result = detector.detectFlask(element);
      
      expect(result).toMatchObject({
        framework: 'flask'
      });
    });
    
    it('should detect Jinja2 templates', () => {
      const element = document.createElement('div');
      element.innerHTML = '<!-- Template: templates/user/profile.html --><p>{{ user.name }}</p>';
      
      const result = detector.detectFlask(element);
      
      expect(result).toMatchObject({
        framework: 'flask',
        template: 'templates/user/profile.html'
      });
    });
  });
  
  describe('Laravel detection', () => {
    it('should detect Laravel via CSRF and Blade templates', () => {
      document.head.innerHTML = '<meta name="csrf-token" content="laravel-token">';
      const element = document.createElement('div');
      element.innerHTML = '<!-- resources/views/posts/index.blade.php --><p>Content</p>';
      
      const result = detector.detectLaravel(element);
      
      expect(result).toMatchObject({
        framework: 'laravel',
        template: 'posts/index.blade.php'
      });
    });
    
    it('should detect PHP Debugbar', () => {
      const debugbar = document.createElement('div');
      debugbar.className = 'phpdebugbar';
      document.body.appendChild(debugbar);
      
      const element = document.createElement('div');
      
      const result = detector.detectLaravel(element);
      
      expect(result).toMatchObject({
        framework: 'laravel'
      });
    });
  });
  
  describe('Phoenix/LiveView detection', () => {
    it('should detect Phoenix LiveView', () => {
      const main = document.createElement('div');
      main.setAttribute('data-phx-main', 'true');
      document.body.appendChild(main);
      
      const element = document.createElement('div');
      element.setAttribute('data-phx-session', 'session-id');
      element.setAttribute('data-phx-view', 'UserLive.Index');
      
      const result = detector.detectPhoenix(element);
      
      expect(result).toMatchObject({
        framework: 'phoenix',
        controller: 'UserLive.Index'
      });
    });
    
    it('should detect Phoenix components', () => {
      const element = document.createElement('div');
      element.setAttribute('data-phx-component', 'MyAppWeb.ButtonComponent');
      element.setAttribute('data-phx-static', 'static-id');
      
      const result = detector.detectPhoenix(element);
      
      expect(result).toMatchObject({
        framework: 'phoenix',
        controller: 'MyAppWeb.ButtonComponent'
      });
    });
  });
  
  describe('ASP.NET detection', () => {
    it('should detect ASP.NET tag helpers', () => {
      const element = document.createElement('a');
      element.setAttribute('asp-controller', 'Home');
      element.setAttribute('asp-action', 'Index');
      
      const result = detector.detectASPNET(element);
      
      expect(result).toMatchObject({
        framework: 'aspnet',
        controller: 'Home',
        action: 'Index'
      });
    });
    
    it('should detect Blazor components', () => {
      const element = document.createElement('div');
      element.setAttribute('b-component', 'Counter');
      
      const result = detector.detectASPNET(element);
      
      expect(result).toMatchObject({
        framework: 'blazor',
        controller: 'Counter'
      });
    });
    
    it('should detect Razor pages', () => {
      const element = document.createElement('form');
      element.setAttribute('asp-page', '/Users/Edit');
      
      const result = detector.detectASPNET(element);
      
      expect(result).toMatchObject({
        framework: 'aspnet',
        template: '/Users/Edit'
      });
    });
  });
  
  describe('Express.js detection', () => {
    it('should detect Pug templates', () => {
      const element = document.createElement('div');
      element.innerHTML = '<!-- views/layout.pug --><p>Content</p>';
      
      const result = detector.detectExpress(element);
      
      expect(result).toMatchObject({
        framework: 'express',
        template: 'layout.pug'
      });
    });
    
    it('should detect EJS templates', () => {
      const element = document.createElement('div');
      element.innerHTML = '<!-- views/users/profile.ejs --><p><%= user.name %></p>';
      
      const result = detector.detectExpress(element);
      
      expect(result).toMatchObject({
        framework: 'express',
        template: 'users/profile.ejs'
      });
    });
    
    it('should detect Handlebars templates', () => {
      const element = document.createElement('div');
      element.innerHTML = '<!-- views/partials/header.hbs --><p>{{title}}</p>';
      
      const result = detector.detectExpress(element);
      
      expect(result).toMatchObject({
        framework: 'express',
        template: 'partials/header.hbs'
      });
    });
  });
  
  describe('WordPress detection', () => {
    it('should detect WordPress via generator meta tag', () => {
      document.head.innerHTML = '<meta name="generator" content="WordPress 6.0">';
      const element = document.createElement('div');
      
      const result = detector.detectWordPress(element);
      
      expect(result).toMatchObject({
        framework: 'wordpress'
      });
    });
    
    it('should detect WordPress admin bar', () => {
      const adminBar = document.createElement('div');
      adminBar.id = 'wpadminbar';
      document.body.appendChild(adminBar);
      
      const element = document.createElement('div');
      
      const result = detector.detectWordPress(element);
      
      expect(result).toMatchObject({
        framework: 'wordpress'
      });
    });
    
    it('should extract WordPress template info', () => {
      document.head.innerHTML = '<meta name="generator" content="WordPress">';
      const element = document.createElement('div');
      element.innerHTML = '<!-- Template: single-post.php --><article>Content</article>';
      
      const result = detector.detectWordPress(element);
      
      expect(result).toMatchObject({
        framework: 'wordpress',
        template: 'single-post.php'
      });
    });
  });
  
  describe('Main detect method', () => {
    it('should try all detectors and return first match', () => {
      // Setup Rails
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const element = document.createElement('div');
      element.setAttribute('data-controller', 'posts');
      
      const result = detector.detect(element);
      
      expect(result).toMatchObject({
        framework: 'rails',
        controller: 'posts'
      });
    });
    
    it('should return null if no framework detected', () => {
      const element = document.createElement('div');
      
      const result = detector.detect(element);
      
      expect(result).toBeNull();
    });
    
    it('should handle multiple frameworks (first wins)', () => {
      // Setup both Rails and Django markers
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const djangoDebug = document.createElement('div');
      djangoDebug.id = 'djDebug';
      document.body.appendChild(djangoDebug);
      
      const element = document.createElement('div');
      element.setAttribute('data-controller', 'posts');
      
      const result = detector.detect(element);
      
      // Rails is checked first, so it should win
      expect(result?.framework).toBe('rails');
    });
  });
  
  describe('Helper methods', () => {
    it('should extract HTML comments from element tree', () => {
      const element = document.createElement('div');
      element.innerHTML = `
        <!-- First comment -->
        <p>Content</p>
        <!-- Second comment -->
        <div>
          <!-- Nested comment -->
        </div>
      `;
      
      const comments = detector['extractHTMLComments'](element);
      
      expect(comments).toContain('First comment');
      expect(comments).toContain('Second comment');
      expect(comments).toContain('Nested comment');
    });
    
    it('should extract Rails controller name from template path', () => {
      const controller = detector['extractRailsController']('app/views/admin/users/index.html.erb');
      expect(controller).toBe('AdminUsersController');
    });
    
    it('should extract Rails action name from template path', () => {
      const action = detector['extractRailsAction']('app/views/posts/show.html.erb');
      expect(action).toBe('show');
    });
  });
});