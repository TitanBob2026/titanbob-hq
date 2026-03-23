/**
 * Shared gateway RPC client.
 *
 * Makes direct WebSocket RPC calls to the OpenClaw gateway for workspace
 * file access. Used as a fallback when the workspace directory is not
 * locally accessible (e.g. Nerve on DGX host, workspace in sandbox).
 *
 * Uses Nerve's existing gateway connection config (GATEWAY_URL + token)
 * rather than shelling out to the `openclaw` CLI which requires its own
 * separate configuration.
 * @module
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { config } from './config.js';
import { DEFAULT_GATEWAY_WS } from './constants.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GatewayFileEntry {
  name: string;
  path: string;
  missing: boolean;
  size: number;
  updatedAtMs: number;
}

export interface GatewayFileWithContent extends GatewayFileEntry {
  content: string;
}

// ── Core RPC call ────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;

/** Derive the WebSocket URL from the HTTP gateway URL. */
function getGatewayWsUrl(): string {
  const httpUrl = config.gatewayUrl;
  if (httpUrl.startsWith('ws://') || httpUrl.startsWith('wss://')) return httpUrl;
  // Convert http(s):// → ws(s)://
  return httpUrl.replace(/^http/, 'ws');
}

/**
 * Execute a gateway RPC call via direct WebSocket connection.
 *
 * Opens a temporary WebSocket to the gateway, authenticates with the
 * gateway token, sends the RPC request, waits for the response, and
 * closes the connection.
 */
export function gatewayRpcCall(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const wsUrl = getGatewayWsUrl();
    const token = config.gatewayToken;
    const reqId = randomUUID();
    let settled = false;
    let ws: WebSocket;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws?.close();
        reject(new Error(`Gateway RPC timeout after ${timeoutMs}ms calling ${method}`));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (ws?.readyState === WebSocket.OPEN) ws.close();
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`Failed to connect to gateway at ${wsUrl}: ${(err as Error).message}`));
      return;
    }

    ws.on('open', () => {
      // Step 1: Send connect with auth token
      const connectMsg = {
        type: 'req',
        id: randomUUID(),
        method: 'connect',
        params: {
          client: { id: 'nerve-rpc', mode: 'api' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          ...(token ? { auth: { token } } : {}),
        },
      };
      ws.send(JSON.stringify(connectMsg));
    });

    ws.on('message', (data: Buffer | string) => {
      if (settled) return;

      try {
        const msg = JSON.parse(data.toString());

        // Wait for connect response before sending the RPC call
        if (msg.type === 'res' && msg.method === 'connect') {
          // Connected — now send the actual RPC request
          ws.send(JSON.stringify({
            type: 'req',
            id: reqId,
            method,
            params,
          }));
          return;
        }

        // Also handle connect.challenge — just ignore and wait for connect response
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          return;
        }

        // Handle the RPC response
        if (msg.type === 'res' && msg.id === reqId) {
          settled = true;
          cleanup();
          if (msg.ok === false) {
            reject(new Error(msg.error?.message || `RPC error calling ${method}`));
          } else {
            resolve(msg.payload ?? msg.result ?? msg);
          }
          return;
        }
      } catch {
        // Ignore parse errors on other messages
      }
    });

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Gateway WebSocket error: ${err.message}`));
      }
    });

    ws.on('close', (code, reason) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Gateway connection closed (${code}): ${reason?.toString() || 'no reason'}`));
      }
    });
  });
}

// ── Typed file RPC wrappers ──────────────────────────────────────────

/**
 * List top-level workspace files for an agent via gateway RPC.
 */
export async function gatewayFilesList(agentId: string): Promise<GatewayFileEntry[]> {
  const result = await gatewayRpcCall('agents.files.list', { agentId }) as { files?: GatewayFileEntry[] };
  return result.files ?? [];
}

/**
 * Read a top-level workspace file via gateway RPC.
 * Returns null if the file is not found or unsupported.
 */
export async function gatewayFilesGet(agentId: string, name: string): Promise<GatewayFileWithContent | null> {
  try {
    const result = await gatewayRpcCall('agents.files.get', { agentId, name }) as GatewayFileWithContent;
    if (!result || result.missing) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Write a top-level workspace file via gateway RPC.
 */
export async function gatewayFilesSet(agentId: string, name: string, content: string): Promise<void> {
  await gatewayRpcCall('agents.files.set', { agentId, name, content });
}
