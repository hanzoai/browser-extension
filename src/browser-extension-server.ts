import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

interface ElementSelectedPayload {
    event: 'elementSelected';
    framework: string | null;
    domPath: string;
    source?: {
        file: string;
        line: number;
        column?: number;
    };
    fallbackId?: string;
}

export class BrowserExtensionServer extends EventEmitter {
    private wss: WebSocketServer;
    private projectRoot: string;

    constructor(port: number = 3001, projectRoot: string = process.cwd()) {
        super();
        this.projectRoot = projectRoot;

        this.wss = new WebSocketServer({
            port,
            path: '/browser-extension'
        });

        this.setupWebSocket();
        console.log(`[Hanzo] Browser extension server listening on ws://localhost:${port}/browser-extension`);
    }

    private setupWebSocket() {
        this.wss.on('connection', (ws) => {
            console.log('[Hanzo] Browser extension connected');

            ws.on('message', async (data) => {
                try {
                    const payload = JSON.parse(data.toString()) as ElementSelectedPayload;

                    if (payload.event === 'elementSelected') {
                        const fileInfo = await this.resolveFileLocation(payload);

                        if (fileInfo) {
                            this.emit('elementSelected', {
                                file: fileInfo.file,
                                line: fileInfo.line,
                                column: fileInfo.column,
                                framework: payload.framework,
                                domPath: payload.domPath
                            });
                        }
                    }
                } catch (error) {
                    console.error('[Hanzo] Error processing browser message:', error);
                }
            });

            ws.on('close', () => {
                console.log('[Hanzo] Browser extension disconnected');
            });
        });
    }

    private async resolveFileLocation(payload: ElementSelectedPayload): Promise<{
        file: string;
        line: number;
        column?: number;
    } | null> {
        // Try source-map location first
        if (payload.source) {
            const resolvedPath = this.resolveSourcePath(payload.source.file);

            // Return the location even if file doesn't exist locally
            // (useful for testing and remote development)
            return {
                file: resolvedPath || payload.source.file,
                line: payload.source.line,
                column: payload.source.column
            };
        }

        // Fallback to data-hanzo-id lookup
        if (payload.fallbackId) {
            const location = await this.lookupByHanzoId(payload.fallbackId);
            if (location) return location;
        }

        console.warn('[Hanzo] Could not resolve file location for element');
        return null;
    }

    private resolveSourcePath(sourcePath: string): string | null {
        // Handle webpack:// protocol
        if (sourcePath.startsWith('webpack://')) {
            sourcePath = sourcePath.replace(/^webpack:\/\/[^\/]+\//, '');
        }

        // Try various path resolutions
        const candidates = [
            path.join(this.projectRoot, sourcePath),
            path.join(this.projectRoot, 'src', sourcePath),
            path.join(this.projectRoot, sourcePath.replace(/^\.\//, '')),
            sourcePath // absolute path
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private async lookupByHanzoId(hanzoId: string): Promise<{
        file: string;
        line: number;
    } | null> {
        // Search for data-hanzo-id in source files
        // This would integrate with the existing tagger system
        try {
            const mapFile = path.join(this.projectRoot, '.hanzo', 'id-map.json');
            if (fs.existsSync(mapFile)) {
                const idMap = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
                return idMap[hanzoId] || null;
            }
        } catch (error) {
            console.error('[Hanzo] Error reading ID map:', error);
        }

        return null;
    }

    public close() {
        this.wss.close();
    }
}
