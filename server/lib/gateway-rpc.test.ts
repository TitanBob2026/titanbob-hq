/** Tests for the shared gateway RPC client (WebSocket-based). */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

// Mock config to point at our test server
let testPort: number;
vi.mock('./config.js', () => ({
  get config() {
    return {
      gatewayUrl: `http://127.0.0.1:${testPort}`,
      gatewayToken: 'test-token',
    };
  },
}));

import {
  gatewayRpcCall,
  gatewayFilesList,
  gatewayFilesGet,
  gatewayFilesSet,
} from './gateway-rpc.js';

describe('gateway-rpc (WebSocket)', () => {
  let wss: WebSocketServer;

  /** Handler for incoming gateway connections — override per test */
  let onConnection: (ws: WebSocket, req: IncomingMessage) => void;

  beforeAll(async () => {
    // Start a local WebSocket server that mimics the gateway protocol
    wss = new WebSocketServer({ port: 0 });
    testPort = (wss.address() as { port: number }).port;

    wss.on('connection', (ws, req) => {
      onConnection(ws, req);
    });
  });

  afterAll(() => {
    wss.close();
  });

  beforeEach(() => {
    onConnection = () => {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Set up a gateway mock that handles connect + one RPC call */
  function mockGateway(rpcHandler: (method: string, params: unknown) => unknown) {
    onConnection = (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.method === 'connect') {
          // Send connect response
          ws.send(JSON.stringify({ type: 'res', id: msg.id, method: 'connect', ok: true, payload: {} }));
          return;
        }

        // RPC call — invoke handler
        try {
          const result = rpcHandler(msg.method, msg.params);
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: result }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'res', id: msg.id, ok: false,
            error: { message: (err as Error).message },
          }));
        }
      });
    };
  }

  describe('gatewayRpcCall', () => {
    it('sends connect then RPC request and returns payload', async () => {
      mockGateway((method, params) => {
        expect(method).toBe('test.method');
        expect(params).toEqual({ foo: 'bar' });
        return { result: 'ok' };
      });

      const result = await gatewayRpcCall('test.method', { foo: 'bar' });
      expect(result).toEqual({ result: 'ok' });
    });

    it('rejects on RPC error response', async () => {
      mockGateway(() => {
        throw new Error('not found');
      });

      await expect(gatewayRpcCall('test.fail', {})).rejects.toThrow('not found');
    });

    it('rejects on timeout', async () => {
      // Gateway never responds to the RPC call
      onConnection = (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'connect') {
            ws.send(JSON.stringify({ type: 'res', id: msg.id, method: 'connect', ok: true, payload: {} }));
          }
          // Don't respond to the RPC call — let it timeout
        });
      };

      await expect(gatewayRpcCall('test.timeout', {}, 500)).rejects.toThrow('timeout');
    });

    it('includes auth token in connect request', async () => {
      let connectParams: Record<string, unknown> = {};

      onConnection = (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'connect') {
            connectParams = msg.params;
            ws.send(JSON.stringify({ type: 'res', id: msg.id, method: 'connect', ok: true, payload: {} }));
          } else {
            ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }));
          }
        });
      };

      await gatewayRpcCall('test.auth', {});
      expect((connectParams as { auth?: { token?: string } }).auth?.token).toBe('test-token');
    });
  });

  describe('gatewayFilesList', () => {
    it('returns files from gateway response', async () => {
      const mockFiles = [
        { name: 'SOUL.md', path: 'SOUL.md', missing: false, size: 100, updatedAtMs: 1000 },
        { name: 'TOOLS.md', path: 'TOOLS.md', missing: false, size: 200, updatedAtMs: 2000 },
      ];

      mockGateway(() => ({ files: mockFiles }));

      const result = await gatewayFilesList('main');
      expect(result).toEqual(mockFiles);
    });

    it('returns empty array when no files in response', async () => {
      mockGateway(() => ({}));

      const result = await gatewayFilesList('main');
      expect(result).toEqual([]);
    });
  });

  describe('gatewayFilesGet', () => {
    it('returns file with content', async () => {
      const mockFile = {
        name: 'SOUL.md', path: 'SOUL.md', missing: false,
        size: 7, updatedAtMs: 1000, content: '# Soul',
      };

      mockGateway(() => mockFile);

      const result = await gatewayFilesGet('main', 'SOUL.md');
      expect(result).toEqual(mockFile);
    });

    it('returns null for missing files', async () => {
      mockGateway(() => ({ name: 'SOUL.md', missing: true }));

      const result = await gatewayFilesGet('main', 'SOUL.md');
      expect(result).toBeNull();
    });

    it('returns null on RPC error', async () => {
      mockGateway(() => { throw new Error('unsupported file'); });

      const result = await gatewayFilesGet('main', 'memory/daily.md');
      expect(result).toBeNull();
    });
  });

  describe('gatewayFilesSet', () => {
    it('sends correct params', async () => {
      let receivedParams: unknown;
      mockGateway((_method, params) => {
        receivedParams = params;
        return { ok: true };
      });

      await gatewayFilesSet('main', 'SOUL.md', '# New Soul');
      expect(receivedParams).toEqual({ agentId: 'main', name: 'SOUL.md', content: '# New Soul' });
    });

    it('rejects on error', async () => {
      mockGateway(() => { throw new Error('write failed'); });

      await expect(gatewayFilesSet('main', 'SOUL.md', 'x')).rejects.toThrow('write failed');
    });
  });
});
