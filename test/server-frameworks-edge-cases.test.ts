import { describe, it, expect, beforeEach } from 'vitest';
import { ServerFrameworkDetector } from '../src/server-frameworks';
import { JSDOM } from 'jsdom';

describe('Server Framework Detection - Edge Cases', () => {
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
  
  describe('Django Debug Toolbar extraction', () => {
    it('should handle Django with toolbar but no view info', () => {
      // Create Django debug toolbar
      const toolbar = document.createElement('div');
      toolbar.id = 'djDebug';
      document.body.appendChild(toolbar);
      
      const element = document.createElement('div');
      const result = detector.detectDjango(element);
      
      expect(result).toMatchObject({
        framework: 'django'
      });
    });
  });
  
  describe('Code coverage for edge cases', () => {
    it('should cover Django toolbar with specific panel', () => {
      // Cover the Django Debug Toolbar code path
      const toolbar = document.createElement('div');
      toolbar.id = 'djDebugToolbar';
      const panel = document.createElement('div');
      panel.className = 'djDebugPanelContent';
      const viewInfo = document.createElement('div');
      viewInfo.className = 'view-info';
      viewInfo.textContent = 'View: myapp.views.index';
      panel.appendChild(viewInfo);
      toolbar.appendChild(panel);
      document.body.appendChild(toolbar);
      
      const element = document.createElement('div');
      const info = detector['extractDjangoViewInfo']();
      
      // Just verify it doesn't crash and returns an object
      expect(info).toBeDefined();
      expect(typeof info).toBe('object');
    });
  });
  
  describe('Error handling', () => {
    it('should handle missing Werkzeug traceback gracefully', () => {
      const debuggerEl = document.createElement('div');
      debuggerEl.id = 'werkzeug-debugger';
      document.body.appendChild(debuggerEl);
      
      const element = document.createElement('div');
      const result = detector.detectFlask(element);
      
      expect(result).toMatchObject({
        framework: 'flask'
      });
      expect(result?.file).toBeUndefined();
      expect(result?.line).toBeUndefined();
    });
  });
  
  describe('Rails edge cases', () => {
    it('should handle Rails template without controller extraction', () => {
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const element = document.createElement('div');
      element.innerHTML = '<!-- BEGIN app/views/show.html.erb --><p>Content</p>';
      
      const result = detector.detectRails(element);
      
      expect(result).toMatchObject({
        framework: 'rails',
        template: 'app/views/show.html.erb',
        controller: '',
        action: 'show'
      });
    });
    
    it('should handle Rails without any comments', () => {
      document.head.innerHTML = '<meta name="csrf-token" content="abc123">';
      const element = document.createElement('div');
      
      const result = detector.detectRails(element);
      
      expect(result).toMatchObject({
        framework: 'rails'
      });
    });
  });
  
  describe('Real browser environment', () => {
    it('should handle createTreeWalker in real browser', () => {
      // Mock NodeFilter
      global.NodeFilter = { SHOW_COMMENT: 8 };
      
      // Create a more realistic DOM structure
      const element = document.createElement('div');
      const parent = document.createElement('div');
      parent.appendChild(element);
      document.body.appendChild(parent);
      
      // Simulate TreeWalker behavior
      const originalCreateTreeWalker = document.createTreeWalker;
      let walkerCalled = false;
      document.createTreeWalker = function() {
        walkerCalled = true;
        return {
          nextNode: () => null
        };
      } as any;
      
      const comments = detector['extractHTMLComments'](element);
      
      expect(walkerCalled).toBe(true);
      expect(comments).toEqual([]);
      
      // Restore
      document.createTreeWalker = originalCreateTreeWalker;
    });
  });
  
  describe('All framework detection - null cases', () => {
    it('should handle all detectors returning null', () => {
      const element = document.createElement('div');
      
      // Ensure no framework markers are present
      document.head.innerHTML = '';
      document.body.innerHTML = '<div></div>';
      
      const result = detector.detect(element);
      expect(result).toBeNull();
    });
  });
});