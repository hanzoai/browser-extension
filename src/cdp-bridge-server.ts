#!/usr/bin/env node
/**
 * CDP Bridge Server - Unified browser control interface
 *
 * Provides hanzo.browser(action, params) interface matching hanzo-mcp pattern.
 * Browser extension connects to this server for remote control.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

interface CDPClient {
  ws: WebSocket;
  capabilities: string[];
  tabId?: number;
}

interface BrowserCommand {
  action: string;
  // Navigation
  url?: string;
  // Selectors
  selector?: string;
  ref?: string;
  element?: string;
  // Input
  text?: string;
  value?: string;
  key?: string;
  // Screenshot
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
  filename?: string;
  // Evaluate
  code?: string;
  function?: string;
  expression?: string;
  // Tabs
  tabId?: number;
  tabIndex?: number;
  // Wait
  timeout?: number;
  state?: string;
  // Generic
  [key: string]: any;
}

class CDPBridgeServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, CDPClient> = new Map();
  private pendingCommands: Map<number, { resolve: Function; reject: Function }> = new Map();
  private commandId = 0;
  private httpPort: number;

  constructor(port: number = 9223) {
    this.httpPort = port;
    this.wss = new WebSocketServer({ port, path: '/cdp' });

    this.wss.on('connection', (ws) => {
      console.log('[hanzo.browser] Extension connected');

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error: any) {
          console.error('[hanzo.browser] Error:', error.message);
        }
      });

      ws.on('close', () => {
        console.log('[hanzo.browser] Extension disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('[hanzo.browser] WebSocket error:', error);
      });
    });

    console.log(`[hanzo.browser] Server listening on ws://localhost:${port}/cdp`);
  }

  private handleMessage(ws: WebSocket, message: any) {
    if (message.type === 'register') {
      this.clients.set(ws, {
        ws,
        capabilities: message.capabilities || []
      });
      console.log('[hanzo.browser] Registered:', message.capabilities?.join(', '));
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pendingCommands.get(message.id);
      if (pending) {
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        this.pendingCommands.delete(message.id);
      }
      return;
    }

    if (message.type === 'event') {
      console.log(`[hanzo.browser] Event: ${message.method}`);
    }
  }

  private async sendRaw(method: string, params?: any): Promise<any> {
    const client = Array.from(this.clients.values())[0];
    if (!client) {
      throw new Error('No browser extension connected');
    }

    const id = ++this.commandId;

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });
      client.ws.send(JSON.stringify({ id, method, params }));

      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error('Command timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Unified hanzo.browser interface - matches mcp__hanzo__browser pattern
   */
  async browser(params: BrowserCommand): Promise<any> {
    const { action, ...rest } = params;

    switch (action) {
      // Navigation
      case 'navigate':
        return this.sendRaw('Page.navigate', { url: rest.url });

      case 'navigate_back':
      case 'go_back':
        return this.sendRaw('Page.goBack');

      case 'navigate_forward':
      case 'go_forward':
        return this.sendRaw('Page.goForward');

      case 'reload':
        return this.sendRaw('Page.reload');

      case 'url':
        return this.sendRaw('Runtime.evaluate', {
          expression: 'window.location.href',
          returnByValue: true
        });

      case 'title':
        return this.sendRaw('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true
        });

      case 'content':
        return this.sendRaw('Runtime.evaluate', {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true
        });

      // Screenshots
      case 'screenshot':
        const screenshot = await this.sendRaw('hanzo.screenshot', {
          format: rest.format || 'png',
          fullPage: rest.fullPage
        });
        if (rest.filename && screenshot.data) {
          const buffer = Buffer.from(screenshot.data, 'base64');
          fs.writeFileSync(rest.filename, buffer);
          return { saved: rest.filename, bytes: buffer.length };
        }
        return screenshot;

      case 'snapshot':
        // Accessibility snapshot
        return this.sendRaw('Accessibility.getFullAXTree');

      // Input - Click
      case 'click':
        return this.sendRaw('hanzo.click', {
          selector: rest.selector || rest.ref
        });

      case 'dblclick':
      case 'double_click':
        return this.sendRaw('hanzo.dblclick', {
          selector: rest.selector || rest.ref
        });

      case 'hover':
        return this.sendRaw('hanzo.hover', {
          selector: rest.selector || rest.ref
        });

      // Input - Type
      case 'type':
        return this.sendRaw('hanzo.type', {
          selector: rest.selector || rest.ref,
          text: rest.text
        });

      case 'fill':
        return this.sendRaw('hanzo.fill', {
          selector: rest.selector || rest.ref,
          value: rest.value || rest.text
        });

      case 'clear':
        return this.sendRaw('hanzo.clear', {
          selector: rest.selector || rest.ref
        });

      case 'press_key':
      case 'press':
        return this.sendRaw('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: rest.key
        });

      // Forms
      case 'select_option':
        return this.sendRaw('hanzo.select', {
          selector: rest.selector || rest.ref,
          value: rest.value
        });

      case 'check':
        return this.sendRaw('hanzo.check', {
          selector: rest.selector || rest.ref
        });

      case 'uncheck':
        return this.sendRaw('hanzo.uncheck', {
          selector: rest.selector || rest.ref
        });

      // Evaluate
      case 'evaluate':
        return this.sendRaw('Runtime.evaluate', {
          expression: rest.code || rest.function || rest.expression,
          returnByValue: true
        });

      // Wait
      case 'wait':
        await new Promise(resolve => setTimeout(resolve, (rest.timeout || 1) * 1000));
        return { waited: rest.timeout || 1 };

      case 'wait_for_load':
        return this.sendRaw('Page.waitForLoadState', {
          state: rest.state || 'load'
        });

      // Tabs
      case 'tabs':
      case 'list_tabs':
        return this.sendRaw('Target.getTargets');

      case 'new_tab':
        return this.sendRaw('Target.createTarget', { url: rest.url || 'about:blank' });

      case 'close_tab':
        return this.sendRaw('Target.closeTarget', { targetId: rest.tabId });

      case 'select_tab':
        return this.sendRaw('Target.activateTarget', { targetId: rest.tabId });

      // Console/Network
      case 'console_messages':
      case 'console':
        return this.sendRaw('Console.getMessages');

      case 'network_requests':
        return this.sendRaw('Network.getResponseBodies');

      // Status
      case 'status':
        return {
          connected: this.clients.size > 0,
          clients: this.clients.size,
          port: this.httpPort
        };

      default:
        // Pass through as raw CDP command
        return this.sendRaw(action, rest);
    }
  }

  isConnected(): boolean {
    return this.clients.size > 0;
  }

  close() {
    this.wss.close();
  }
}

// JSON-RPC server for MCP integration
async function startJSONRPCServer(bridgeServer: CDPBridgeServer) {
  const http = require('http');

  const httpServer = http.createServer(async (req: any, res: any) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: string) => body += chunk);
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          const result = await bridgeServer.browser(request.params || request);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else {
      // GET - return status
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'hanzo.browser',
        connected: bridgeServer.isConnected(),
        actions: [
          'navigate', 'navigate_back', 'reload', 'url', 'title', 'content',
          'screenshot', 'snapshot',
          'click', 'dblclick', 'hover', 'type', 'fill', 'clear', 'press_key',
          'select_option', 'check', 'uncheck',
          'evaluate',
          'wait', 'wait_for_load',
          'tabs', 'new_tab', 'close_tab', 'select_tab',
          'console', 'network_requests',
          'status'
        ]
      }));
    }
  });

  httpServer.listen(9224, () => {
    console.log('[hanzo.browser] HTTP API at http://localhost:9224');
  });
}

// Interactive CLI
async function main() {
  const port = parseInt(process.env.CDP_PORT || '9223');
  const server = new CDPBridgeServer(port);

  // Start HTTP API
  startJSONRPCServer(server);

  console.log('\n[hanzo.browser] Commands:');
  console.log('  navigate <url>      - Go to URL');
  console.log('  screenshot [file]   - Capture screen');
  console.log('  click <selector>    - Click element');
  console.log('  type <sel> <text>   - Type into element');
  console.log('  eval <js>           - Run JavaScript');
  console.log('  tabs                - List all tabs');
  console.log('  status              - Connection status');
  console.log('  quit                - Exit\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = () => {
    rl.question('hanzo.browser> ', async (line) => {
      const parts = line.trim().split(' ');
      const action = parts[0];
      const args = parts.slice(1);

      if (!action) {
        prompt();
        return;
      }

      try {
        let result;

        switch (action) {
          case 'quit':
          case 'exit':
            server.close();
            rl.close();
            process.exit(0);

          case 'navigate':
            result = await server.browser({ action: 'navigate', url: args[0] });
            console.log('Navigated to:', args[0]);
            break;

          case 'screenshot':
            result = await server.browser({
              action: 'screenshot',
              filename: args[0] || `screenshot-${Date.now()}.png`
            });
            console.log('Screenshot:', result);
            break;

          case 'click':
            result = await server.browser({ action: 'click', selector: args[0] });
            console.log('Clicked:', args[0]);
            break;

          case 'type':
            result = await server.browser({
              action: 'type',
              selector: args[0],
              text: args.slice(1).join(' ')
            });
            console.log('Typed into:', args[0]);
            break;

          case 'eval':
            result = await server.browser({
              action: 'evaluate',
              expression: args.join(' ')
            });
            console.log('Result:', result?.result?.value);
            break;

          case 'tabs':
            result = await server.browser({ action: 'tabs' });
            console.log('Tabs:', result?.targetInfos?.map((t: any) => t.title).join(', '));
            break;

          case 'status':
            result = await server.browser({ action: 'status' });
            console.log('Status:', result);
            break;

          case 'url':
            result = await server.browser({ action: 'url' });
            console.log('URL:', result?.result?.value);
            break;

          case 'title':
            result = await server.browser({ action: 'title' });
            console.log('Title:', result?.result?.value);
            break;

          default:
            // Try as raw action
            result = await server.browser({ action, ...Object.fromEntries(
              args.map((a, i) => [i === 0 ? 'selector' : `arg${i}`, a])
            )});
            console.log('Result:', result);
        }
      } catch (error: any) {
        console.error('Error:', error.message);
      }

      prompt();
    });
  };

  prompt();
}

export { CDPBridgeServer, BrowserCommand };

if (require.main === module) {
  main();
}
