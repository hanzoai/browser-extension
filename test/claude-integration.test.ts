import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserExtensionServer } from '../../vscode/src/mcp-tools/browser-extension-server';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';

describe('Claude Code Browser Extension Integration', () => {
  let server: BrowserExtensionServer;
  let ws: WebSocket;
  const TEST_PORT = 3002;
  
  beforeEach(async () => {
    // Start server
    server = new BrowserExtensionServer(TEST_PORT, process.cwd());
    
    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Connect WebSocket
    ws = new WebSocket(`ws://localhost:${TEST_PORT}/browser-extension`);
    await new Promise(resolve => ws.on('open', resolve));
  });
  
  afterEach(() => {
    ws.close();
    server.close();
  });
  
  describe('React source-map integration', () => {
    it('should handle React component with __source', async () => {
      const elementSelected = new Promise((resolve) => {
        server.on('elementSelected', resolve);
      });
      
      // Simulate React element click with source-map data
      ws.send(JSON.stringify({
        event: 'elementSelected',
        framework: 'react',
        domPath: 'div#root > div.App > button.submit-btn',
        source: {
          file: 'src/components/SubmitButton.tsx',
          line: 42,
          column: 12
        }
      }));
      
      const result = await elementSelected;
      
      expect(result).toMatchObject({
        file: expect.stringContaining('SubmitButton.tsx'),
        line: 42,
        column: 12,
        framework: 'react'
      });
    });
    
    it('should resolve webpack:// protocol paths', async () => {
      const elementSelected = new Promise((resolve) => {
        server.on('elementSelected', resolve);
      });
      
      ws.send(JSON.stringify({
        event: 'elementSelected',
        framework: 'react',
        domPath: 'header > nav > a',
        source: {
          file: 'webpack://my-app/./src/components/Navigation.jsx',
          line: 15
        }
      }));
      
      const result = await elementSelected;
      
      expect(result).toMatchObject({
        file: expect.stringContaining('Navigation.jsx'),
        line: 15,
        framework: 'react'
      });
    });
  });
  
  describe('Vue source-map integration', () => {
    it('should handle Vue component with __file', async () => {
      const elementSelected = new Promise((resolve) => {
        server.on('elementSelected', resolve);
      });
      
      ws.send(JSON.stringify({
        event: 'elementSelected',
        framework: 'vue',
        domPath: 'div#app > main > custom-button',
        source: {
          file: 'src/components/CustomButton.vue',
          line: 28
        }
      }));
      
      const result = await elementSelected;
      
      expect(result).toMatchObject({
        file: expect.stringContaining('CustomButton.vue'),
        line: 28,
        framework: 'vue'
      });
    });
  });
  
  describe('Fallback to data-hanzo-id', () => {
    it('should handle elements without source-map data', async () => {
      // Create the .hanzo directory and id-map.json for test
      const hanzoDir = path.join(process.cwd(), '.hanzo');
      const mapFile = path.join(hanzoDir, 'id-map.json');
      
      if (!fs.existsSync(hanzoDir)) {
        fs.mkdirSync(hanzoDir, { recursive: true });
      }
      
      // Write test id map
      fs.writeFileSync(mapFile, JSON.stringify({
        'hanzo-abc123': {
          file: path.join(process.cwd(), 'src/legacy/OldComponent.js'),
          line: 55
        }
      }));
      
      const elementSelected = new Promise((resolve) => {
        server.once('elementSelected', resolve);
      });
      
      ws.send(JSON.stringify({
        event: 'elementSelected',
        framework: null,
        domPath: 'body > div.legacy > span',
        fallbackId: 'hanzo-abc123'
      }));
      
      const result = await elementSelected;
      
      expect(result).toMatchObject({
        file: expect.stringContaining('OldComponent.js'),
        line: 55
      });
      
      // Cleanup
      if (fs.existsSync(mapFile)) {
        fs.unlinkSync(mapFile);
      }
    });
  });
  
  describe('Claude Code MCP integration', () => {
    it('should format events for Claude Code consumption', async () => {
      const events: any[] = [];
      
      server.on('elementSelected', (data) => {
        events.push({
          tool: 'browser_navigate_to_source',
          arguments: {
            file: data.file,
            line: data.line,
            column: data.column,
            reason: `User clicked ${data.framework ? data.framework.charAt(0).toUpperCase() + data.framework.slice(1) : 'HTML'} element at ${data.domPath}`
          }
        });
      });
      
      // Send multiple events
      const testCases = [
        {
          framework: 'react',
          source: { file: 'App.tsx', line: 10, column: 4 },
          domPath: 'div#root > div.App'
        },
        {
          framework: 'vue',
          source: { file: 'Home.vue', line: 45 },
          domPath: 'div#app > router-view > div.home'
        }
      ];
      
      for (const testCase of testCases) {
        ws.send(JSON.stringify({
          event: 'elementSelected',
          ...testCase
        }));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      expect(events).toHaveLength(2);
      expect(events[0].tool).toBe('browser_navigate_to_source');
      expect(events[0].arguments.reason).toContain('React element');
      expect(events[1].arguments.reason).toContain('Vue element');
    });
  });
  
  describe('Error handling', () => {
    it('should handle malformed messages gracefully', async () => {
      // Server should not crash on bad input
      ws.send('invalid json');
      ws.send(JSON.stringify({ invalid: 'event' }));
      ws.send(JSON.stringify({ event: 'unknown' }));
      
      // Give time for messages to process
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Server should still be responsive
      const elementSelected = new Promise((resolve) => {
        server.on('elementSelected', resolve);
      });
      
      ws.send(JSON.stringify({
        event: 'elementSelected',
        framework: 'react',
        source: { file: 'test.tsx', line: 1 }
      }));
      
      const result = await elementSelected;
      expect(result).toBeDefined();
    });
  });
  
  describe('Performance', () => {
    it('should handle rapid clicks efficiently', async () => {
      const events: any[] = [];
      server.on('elementSelected', (data) => events.push(data));
      
      // Send 100 events rapidly
      const startTime = Date.now();
      
      for (let i = 0; i < 100; i++) {
        ws.send(JSON.stringify({
          event: 'elementSelected',
          framework: 'react',
          domPath: `div#item-${i}`,
          source: {
            file: `Component${i}.tsx`,
            line: i + 1
          }
        }));
      }
      
      // Wait for all events to process
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const duration = Date.now() - startTime;
      
      expect(events).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Should process 100 events in under 1 second
    });
  });
});