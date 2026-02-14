/**
 * ZAP Extension Client for Browser Extension
 *
 * Lightweight client for browser extensions to connect directly to MCP servers.
 * Supports multiple MCP connections and auto-discovery.
 */

// ============================================================================
// Types
// ============================================================================

export enum ClientType {
  McpServer = 0,
  McpClient = 1,
  BrowserExtension = 2,
  Agent = 3,
}

export enum BrowserAction {
  Navigate = 1,
  Back = 2,
  Forward = 3,
  Refresh = 4,
  Click = 10,
  Type = 11,
  Fill = 12,
  Select = 13,
  Hover = 14,
  Scroll = 15,
  Evaluate = 20,
  WaitFor = 21,
  GetAttribute = 22,
  GetText = 23,
  Screenshot = 40,
  Pdf = 41,
  GetTabs = 50,
  SwitchTab = 51,
  NewTab = 52,
  CloseTab = 53,
  GetCookies = 60,
  SetCookies = 61,
  ClearCookies = 62,
  GetStorage = 70,
  SetStorage = 71,
  ClearStorage = 72,
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: string;
}

export interface McpInfo {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  tools: ToolInfo[];
}

export interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface ZapRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ZapResponse {
  id: string;
  result?: unknown;
  error?: {
    code: number | string;
    message: string;
    data?: unknown;
  };
}

export interface Handshake {
  version: string;
  clientType: ClientType;
  clientId: string;
  capabilities: string[];
  metadata?: Record<string, string>;
}

export interface HandshakeResponse {
  accepted: boolean;
  clientId: string;
  serverVersion: string;
  capabilities: string[];
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZapEventHandler = (data: any) => void;

// ============================================================================
// Protocol
// ============================================================================

const ZAP_MAGIC = new Uint8Array([0x5a, 0x41, 0x50, 0x01]); // "ZAP\x01"

enum MessageType {
  Handshake = 1,
  HandshakeResponse = 2,
  Request = 3,
  Response = 4,
  Stream = 5,
  Ping = 6,
  Pong = 7,
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function generateClientId(): string {
  return `ext-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

class Protocol {
  private binary: boolean;

  constructor(binary = true) {
    this.binary = binary;
  }

  encode(type: MessageType, data: unknown): ArrayBuffer | string {
    if (!this.binary) {
      return JSON.stringify({ t: type, d: data });
    }

    const json = JSON.stringify(data);
    const jsonBytes = new TextEncoder().encode(json);
    const buffer = new ArrayBuffer(5 + jsonBytes.length);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);

    arr.set(ZAP_MAGIC, 0);
    view.setUint8(4, type);
    arr.set(jsonBytes, 5);

    return buffer;
  }

  decode(data: ArrayBuffer | string): { type: MessageType; payload: unknown } {
    if (typeof data === 'string') {
      const parsed = JSON.parse(data);
      return { type: parsed.t, payload: parsed.d };
    }

    const view = new DataView(data);
    const arr = new Uint8Array(data);

    // Verify magic
    for (let i = 0; i < 4; i++) {
      if (arr[i] !== ZAP_MAGIC[i]) {
        throw new Error('Invalid ZAP message');
      }
    }

    const type = view.getUint8(4) as MessageType;
    const jsonBytes = arr.slice(5);
    const json = new TextDecoder().decode(jsonBytes);
    const payload = JSON.parse(json);

    return { type, payload };
  }

  encodeHandshake(handshake: Handshake): ArrayBuffer | string {
    return this.encode(MessageType.Handshake, handshake);
  }

  encodeRequest(request: ZapRequest): ArrayBuffer | string {
    return this.encode(MessageType.Request, request);
  }

  encodeResponse(response: ZapResponse): ArrayBuffer | string {
    return this.encode(MessageType.Response, response);
  }

  encodePing(): ArrayBuffer | string {
    return this.encode(MessageType.Ping, { ts: Date.now() });
  }

  encodePong(ts: number): ArrayBuffer | string {
    return this.encode(MessageType.Pong, { ts });
  }
}

// ============================================================================
// Errors
// ============================================================================

export class ZapError extends Error {
  readonly code: number | string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: number | string = -32603, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ZapError';
    this.code = code;
    this.details = details;
  }
}

export class ConnectionError extends ZapError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONNECTION_ERROR', details);
    this.name = 'ConnectionError';
  }
}

export class TimeoutError extends ZapError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TIMEOUT_ERROR', details);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// ZAP Client (single MCP connection)
// ============================================================================

interface ZapClientOptions {
  clientId?: string;
  clientType?: ClientType;
  capabilities?: string[];
  timeout?: number;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  binary?: boolean;
}

class ZapClient {
  private ws: WebSocket | null = null;
  private protocol: Protocol;
  private options: Required<ZapClientOptions>;
  private state: ConnectionState = 'disconnected';
  private serverInfo: HandshakeResponse | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private eventHandlers = new Map<string, Set<ZapEventHandler>>();
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private url: string | null = null;

  constructor(options: ZapClientOptions = {}) {
    this.options = {
      clientId: options.clientId ?? generateClientId(),
      clientType: options.clientType ?? ClientType.McpClient,
      capabilities: options.capabilities ?? ['tools', 'browser', 'mcp'],
      timeout: options.timeout ?? 30000,
      autoReconnect: options.autoReconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 1000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      binary: options.binary ?? true,
    };
    this.protocol = new Protocol(this.options.binary);
  }

  get isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(url: string): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new ConnectionError('Already connected or connecting');
    }

    this.url = url;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.state = 'disconnected';
        reject(new TimeoutError('Connection timeout'));
      }, this.options.timeout);

      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          const handshake: Handshake = {
            version: '1.0.0',
            clientType: this.options.clientType,
            clientId: this.options.clientId,
            capabilities: this.options.capabilities,
          };
          this.send(this.protocol.encodeHandshake(handshake));
        };

        this.ws.onmessage = (event) => {
          const { type, payload } = this.protocol.decode(event.data);

          if (type === MessageType.HandshakeResponse) {
            clearTimeout(timeout);
            const response = payload as HandshakeResponse;

            if (response.accepted) {
              this.serverInfo = response;
              this.state = 'connected';
              this.reconnectAttempts = 0;
              this.emit('connect', response);
              resolve();
            } else {
              this.state = 'disconnected';
              reject(new ConnectionError(response.error ?? 'Connection rejected'));
            }
          } else if (type === MessageType.Response) {
            this.handleResponse(payload as ZapResponse);
          } else if (type === MessageType.Stream) {
            this.emit('stream', payload);
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
          this.emit('error', new ConnectionError('WebSocket error'));
          if (this.state === 'connecting') {
            this.state = 'disconnected';
            reject(new ConnectionError('WebSocket error'));
          }
        };

        this.ws.onclose = () => {
          const wasConnected = this.state === 'connected';
          this.state = 'disconnected';
          this.emit('disconnect', { wasConnected });

          if (wasConnected && this.options.autoReconnect && this.url) {
            this.scheduleReconnect();
          }
        };
      } catch (error) {
        clearTimeout(timeout);
        this.state = 'disconnected';
        reject(new ConnectionError(`Failed to connect: ${error}`));
      }
    });
  }

  async close(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new ConnectionError('Connection closed'));
    }
    this.pendingRequests.clear();
    this.state = 'disconnected';
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.isConnected) {
      throw new ConnectionError('Not connected');
    }

    const id = generateId();
    const request: ZapRequest = { id, method, params: params as Record<string, unknown> };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new TimeoutError(`Request timeout: ${method}`));
      }, this.options.timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.send(this.protocol.encodeRequest(request));
    });
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.request<{ tools: Tool[] }>('tools/list');
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.request<ToolResult>('tools/call', { name, arguments: args });
  }

  on(event: string, handler: ZapEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: ZapEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private send(data: ArrayBuffer | string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private handleResponse(response: ZapResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new ZapError(response.error.message, response.error.code));
    } else {
      pending.resolve(response.result);
    }
  }

  private emit(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (e) {
        console.error('Event handler error:', e);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit('error', new ConnectionError('Max reconnect attempts reached'));
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;

    const delay = this.options.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1);

    this.reconnectTimeout = setTimeout(async () => {
      if (this.url) {
        try {
          await this.connect(this.url);
          this.emit('reconnect', { attempts: this.reconnectAttempts });
        } catch {
          // Will retry via onclose handler
        }
      }
    }, delay);
  }
}

// ============================================================================
// MCP Connection Manager
// ============================================================================

interface McpConnection {
  client: ZapClient;
  info: McpInfo;
  connected: boolean;
}

// ============================================================================
// ZAP Extension Client (multi-MCP support)
// ============================================================================

export interface ZapExtensionClientOptions {
  extensionId?: string;
  browser?: string;
  version?: string;
  capabilities?: string[];
  timeout?: number;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  binary?: boolean;
}

const DEFAULT_DISCOVERY_PORTS = [9999, 9998, 9997, 9996, 9995];
const DEFAULT_DISCOVERY_TIMEOUT = 2000;

/**
 * ZAP Extension Client - Browser extension client supporting multiple MCPs
 */
export class ZapExtensionClient {
  private extensionId: string;
  private browser: string;
  private version: string;
  private capabilities: string[];
  private mcpConnections = new Map<string, McpConnection>();
  private eventHandlers = new Map<string, Set<ZapEventHandler>>();
  private options: ZapClientOptions;

  constructor(options: ZapExtensionClientOptions = {}) {
    this.extensionId = options.extensionId ?? generateClientId();
    this.browser = options.browser ?? 'unknown';
    this.version = options.version ?? '1.0.0';
    this.capabilities = options.capabilities ?? [
      'tabs',
      'navigate',
      'screenshot',
      'evaluate',
      'cookies',
      'storage',
    ];
    this.options = {
      clientId: this.extensionId,
      clientType: ClientType.BrowserExtension,
      capabilities: this.capabilities,
      timeout: options.timeout ?? 30000,
      autoReconnect: options.autoReconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 1000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      binary: options.binary ?? true,
    };
  }

  get id(): string {
    return this.extensionId;
  }

  get mcps(): McpInfo[] {
    return Array.from(this.mcpConnections.values())
      .filter((c) => c.connected)
      .map((c) => c.info);
  }

  get connectionCount(): number {
    return Array.from(this.mcpConnections.values()).filter((c) => c.connected).length;
  }

  /**
   * Discover available MCP servers by probing ports
   */
  async discover(
    ports = DEFAULT_DISCOVERY_PORTS,
    timeout = DEFAULT_DISCOVERY_TIMEOUT
  ): Promise<McpInfo[]> {
    const discovered: McpInfo[] = [];

    await Promise.all(
      ports.map(async (port) => {
        try {
          const url = `ws://localhost:${port}`;
          const mcp = await this.probeServer(url, timeout);
          if (mcp) {
            discovered.push(mcp);
          }
        } catch {
          // Server not available on this port
        }
      })
    );

    return discovered;
  }

  /**
   * Connect to an MCP server
   */
  async connectMcp(url: string): Promise<McpInfo> {
    // Check if already connected
    const existing = Array.from(this.mcpConnections.values()).find(
      (c) => c.info.url === url && c.connected
    );
    if (existing) {
      return existing.info;
    }

    const client = new ZapClient({
      ...this.options,
      clientId: `${this.extensionId}:${Date.now()}`,
    });

    try {
      await client.connect(url);

      // Get tools
      const tools = await client.listTools();

      const info: McpInfo = {
        id: generateClientId(),
        name: `MCP@${url}`,
        url,
        connected: true,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: JSON.stringify(t.schema),
        })),
      };

      const connection: McpConnection = {
        client,
        info,
        connected: true,
      };

      this.mcpConnections.set(info.id, connection);

      // Handle disconnect
      client.on('disconnect', () => {
        connection.connected = false;
        connection.info.connected = false;
        this.emit('mcp:disconnect', info);
      });

      client.on('reconnect', () => {
        connection.connected = true;
        connection.info.connected = true;
        this.emit('mcp:reconnect', info);
      });

      this.emit('mcp:connect', info);

      return info;
    } catch (error) {
      throw new ConnectionError(`Failed to connect to MCP at ${url}: ${error}`);
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectMcp(mcpId: string): Promise<void> {
    const connection = this.mcpConnections.get(mcpId);
    if (!connection) return;

    await connection.client.close();
    connection.connected = false;
    connection.info.connected = false;
    this.mcpConnections.delete(mcpId);

    this.emit('mcp:disconnect', connection.info);
  }

  /**
   * Disconnect from all MCPs
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.mcpConnections.keys()).map((id) => this.disconnectMcp(id)));
  }

  /**
   * Call a tool on connected MCPs
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    mcpId?: string
  ): Promise<ToolResult> {
    // If MCP specified, use that one
    if (mcpId) {
      const connection = this.mcpConnections.get(mcpId);
      if (!connection?.connected) {
        throw new ZapError(`MCP not connected: ${mcpId}`);
      }
      return connection.client.callTool(name, args);
    }

    // Otherwise, find an MCP that has the tool
    for (const connection of this.mcpConnections.values()) {
      if (!connection.connected) continue;

      const hasTool = connection.info.tools.some((t) => t.name === name);
      if (hasTool) {
        return connection.client.callTool(name, args);
      }
    }

    throw new ZapError(`Tool not found on any connected MCP: ${name}`);
  }

  /**
   * Get all available tools across connected MCPs
   */
  getTools(): ToolInfo[] {
    const tools = new Map<string, ToolInfo>();

    for (const connection of this.mcpConnections.values()) {
      if (!connection.connected) continue;

      for (const tool of connection.info.tools) {
        // Use first occurrence (avoid duplicates)
        if (!tools.has(tool.name)) {
          tools.set(tool.name, tool);
        }
      }
    }

    return Array.from(tools.values());
  }

  /**
   * Subscribe to events
   */
  on(event: string, handler: ZapEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from events
   */
  off(event: string, handler: ZapEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async probeServer(url: string, timeout: number): Promise<McpInfo | null> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        resolve(null);
      }, timeout);

      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        // Server responded, it's available
        resolve({
          id: url,
          name: `MCP@${url}`,
          url,
          connected: false, // Not connected yet, just discovered
          tools: [],
        });
      };

      ws.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };

      ws.onclose = () => {
        clearTimeout(timer);
      };
    });
  }

  private emit(event: string, data: unknown): void {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (e) {
        console.error('Event handler error:', e);
      }
    });
  }
}
