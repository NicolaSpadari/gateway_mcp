#!/usr/bin/env node
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { REGISTRY, type ServerConfig } from "./registry.js";

// Logging configuration
const LOG_LEVEL = process.env.GATEWAY_LOG_LEVEL || "info";
const ENABLE_DEBUG = LOG_LEVEL === "debug";

function logDebug(...args: any[]): void {
  if (ENABLE_DEBUG) {
    console.error("[gateway:debug]", ...args);
  }
}

function logInfo(...args: any[]): void {
  if (LOG_LEVEL !== "silent") {
    console.error("[gateway:info]", ...args);
  }
}

function logError(...args: any[]): void {
  if (LOG_LEVEL !== "silent") {
    console.error("[gateway:error]", ...args);
  }
}

type Connected = {
  cfg: ServerConfig;
  client: Client;
  lastUsed: number;
  idleTtlMs: number;
  // child process handle (null when using transports that manage their own process)
  child: ChildProcess | null;
};

const connected = new Map<string, Connected>();

type StdioTransportConfig = {
  command: string;
  args: string[];
  stderr: "pipe" | "inherit" | "ignore";
  env?: Record<string, string>;
};

async function connectStdio(cfg: ServerConfig): Promise<{ client: Client; child: ChildProcess | null }> {
  logDebug(`Connecting to stdio server: ${cfg.command} ${cfg.args?.join(' ')}`);

  // StdioClientTransport spawns its own process, so we don't need to spawn manually
  const transportConfig: StdioTransportConfig = {
    command: assert(cfg.command, "command required"),
    args: cfg.args ?? [],
    stderr: "pipe"
  };

  if (cfg.env) {
    transportConfig.env = cfg.env;
  }

  const transport = new StdioClientTransport(transportConfig);

  const client = new Client({
    name: "mcp-gateway-client",
    version: "1.0.0",
  }, {
    capabilities: {}
  });

  logDebug("Connecting client to transport...");
  await client.connect(transport);
  logDebug("Client connected successfully");

  // We don't have direct access to the child process when using StdioClientTransport
  return { client, child: null };
}

async function connectWs(_cfg: ServerConfig): Promise<Client> {
  // WebSocket transport is not yet implemented
  // Future implementation would use WebSocketClientTransport from the MCP SDK
  // See: https://modelcontextprotocol.io/docs/develop/build-server
  throw new Error("WebSocket transport is not supported in this version. Use stdio transport instead.");
}

async function connectHttp(cfg: ServerConfig, forceSSE = false): Promise<Client> {
  const url = assert(cfg.url, "url required for http/sse transport");
  logDebug(`Connecting to remote server: ${url} (forceSSE: ${forceSSE})`);

  const baseUrl = new URL(url);

  // If not forcing SSE, try Streamable HTTP first (recommended)
  if (!forceSSE) {
    try {
      const client = new Client(
        { name: "mcp-gateway-client", version: "1.0.0" },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(baseUrl);
      // Type assertion needed due to exactOptionalPropertyTypes incompatibility with SDK
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      logDebug(`Connected to ${cfg.id} using Streamable HTTP transport`);
      return client;
    } catch (err) {
      logDebug(`Streamable HTTP failed for ${cfg.id}, falling back to SSE: ${(err as Error).message}`);
    }
  }

  // Fallback to SSE transport (for older servers or when forced)
  const client = new Client(
    { name: "mcp-gateway-client", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new SSEClientTransport(baseUrl);
  // Type assertion needed due to exactOptionalPropertyTypes incompatibility with SDK
  await client.connect(transport as Parameters<typeof client.connect>[0]);
  logDebug(`Connected to ${cfg.id} using SSE transport`);
  return client;
}

function assert<T>(v: T | undefined, msg: string): T {
  if (v == null) throw new Error(msg);
  return v;
}

function safeCloseClient(client: Client): void {
  try {
    if (typeof client.close === 'function') {
      client.close();
    }
  } catch (err) {
    // Ignore close errors
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
    ),
  ]);
}

function findCfg(serverId: string): ServerConfig {
  const cfg = REGISTRY.find((s) => s.id === serverId);
  if (!cfg) throw new Error(`Unknown serverId: ${serverId}`);
  return cfg;
}

async function ensureConnection(serverId: string): Promise<Connected> {
  const now = Date.now();
  const existing = connected.get(serverId);
  if (existing) {
    existing.lastUsed = now;
    return existing;
  }

  const cfg = findCfg(serverId);
  let client: Client | null = null;
  let child: ChildProcess | null = null;

  try {
    if (cfg.kind === "ws") {
      client = await connectWs(cfg);
    } else if (cfg.kind === "http") {
      // Streamable HTTP with SSE fallback
      client = await connectHttp(cfg, false);
    } else if (cfg.kind === "sse") {
      // Force SSE transport (for servers that only support SSE)
      client = await connectHttp(cfg, true);
    } else {
      // Default: stdio
      const result = await connectStdio(cfg);
      client = result.client;
      child = result.child;
    }

    const conn: Connected = {
      cfg,
      client,
      lastUsed: now,
      idleTtlMs: cfg.idleTtlMs ?? 5 * 60_000,
      child,
    };

    connected.set(serverId, conn);
    return conn;
  } catch (err) {
    // Cleanup on connection failure
    if (client) {
      safeCloseClient(client);
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    throw err;
  }
}

function scheduleGc() {
  setInterval(() => {
    const now = Date.now();
    for (const [id, c] of connected) {
      if (now - c.lastUsed > c.idleTtlMs) {
        // Close connection
        safeCloseClient(c.client);
        try {
          c.child?.kill("SIGTERM");
        } catch {}
        connected.delete(id);
      }
    }
  }, 30_000).unref();
}

const discoverInputSchema = z.object({
  serverId: z.string().describe("The ID of the target MCP server to discover"),
});

const dispatchInputSchema = z.object({
  serverId: z.string().describe("The ID of the target MCP server"),
  tool: z.string().describe("The name of the tool to invoke"),
  args: z.record(z.unknown()).optional().describe("Arguments to pass to the tool"),
});

const closeInputSchema = z.object({
  serverId: z.string().describe("The ID of the target MCP server to close"),
});

async function main() {
  const server = new Server(
    {
      name: "mcp-gateway",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool: discover - returns metadata and tool summary from target server
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "discover",
          description: "Return metadata and tools of a target MCP server without registering them in the client. Call this first to see what tools are available on a server.",
          inputSchema: {
            type: "object",
            properties: {
              serverId: {
                type: "string",
                description: "The ID of the target MCP server. Available servers: " + REGISTRY.map(s => s.id).join(", "),
              },
            },
            required: ["serverId"],
          },
        },
        {
          name: "dispatch",
          description: "Call a tool on a target MCP server. Use discover first to see available tools and their schemas.",
          inputSchema: {
            type: "object",
            properties: {
              serverId: {
                type: "string",
                description: "The ID of the target MCP server",
              },
              tool: {
                type: "string",
                description: "The name of the tool to invoke",
              },
              args: {
                type: "object",
                description: "Arguments to pass to the tool (as a JSON object)",
              },
            },
            required: ["serverId", "tool"],
          },
        },
        {
          name: "close",
          description: "Close and evict a target MCP server connection from the gateway cache.",
          inputSchema: {
            type: "object",
            properties: {
              serverId: {
                type: "string",
                description: "The ID of the target MCP server to close",
              },
            },
            required: ["serverId"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "discover") {
        const { serverId } = discoverInputSchema.parse(args);
        logDebug(`Discovering serverId: ${serverId}`);

        let conn;
        try {
          conn = await ensureConnection(serverId);
          logDebug(`Connection established for ${serverId}`);
        } catch (err: any) {
          logError(`Connection failed for ${serverId}:`, err.message);
          throw err;
        }

        // Request tool/resources list from target server
        let toolsList;
        try {
          logDebug(`Calling listTools() on ${serverId}...`);
          toolsList = await conn.client.listTools();
          logDebug(`listTools returned ${toolsList.tools?.length ?? 0} tools`);
        } catch (err: any) {
          logError(`listTools failed for ${serverId}:`, err.message, err.code);
          throw err;
        }

        let resourcesList;
        try {
          logDebug(`Calling listResources() on ${serverId}...`);
          resourcesList = await conn.client.listResources?.() ?? { resources: [] };
          logDebug(`listResources returned ${resourcesList.resources?.length ?? 0} resources`);
        } catch (err: any) {
          logError(`listResources failed for ${serverId}:`, err.message);
          resourcesList = { resources: [] };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  serverId,
                  tools: toolsList.tools,
                  resources: resourcesList.resources,
                },
                null,
                2
              ),
            },
          ],
        };
      } else if (name === "dispatch") {
        const { serverId, tool, args: toolArgs } = dispatchInputSchema.parse(args);
        const conn = await ensureConnection(serverId);

        // Execute tool call directly and return response content from remote server
        // Add timeout protection (2 minutes default)
        const result = await withTimeout(
          conn.client.callTool({ name: tool, arguments: toolArgs ?? {} }),
          120_000,
          `Tool call '${tool}' on server '${serverId}' timed out after 120 seconds`
        );

        return {
          content: Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === "close") {
        const { serverId } = closeInputSchema.parse(args);
        const c = connected.get(serverId);

        if (!c) {
          return {
            content: [
              { type: "text", text: `serverId ${serverId} not connected` },
            ],
          };
        }

        safeCloseClient(c.client);
        try {
          c.child?.kill("SIGTERM");
        } catch {}
        connected.delete(serverId);

        return {
          content: [{ type: "text", text: `serverId ${serverId} closed` }],
        };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  scheduleGc();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logInfo("MCP Gateway Server running on stdio");
  logInfo(`Log level: ${LOG_LEVEL}. Set GATEWAY_LOG_LEVEL=debug for detailed logs or GATEWAY_LOG_LEVEL=silent to disable.`);
}

main().catch((err) => {
  logError("Fatal error:", err);
  process.exit(1);
});
