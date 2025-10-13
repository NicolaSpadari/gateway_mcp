# MCP Gateway

A lightweight MCP (Model Context Protocol) Gateway that routes requests to downstream MCP servers on-demand, solving context window saturation by exposing only 3 generic tools instead of loading all tools from all servers upfront.

## Problem Solved

**Without Gateway**: Each MCP server registers its tools with the client, consuming context tokens for every tool schema.

**With Gateway**: Only 3 gateway tools are registered (`discover`, `dispatch`, `close`). Downstream server tools load on-demand.

## Architecture

```
Client (Claude Code/Cursor/etc)
    ↓
MCP Gateway (3 tools only)
    ↓
Downstream Servers (loaded on-demand)
    - llm-memory
    - code-trm
    - codex
    - code-analysis
```

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in production
npm start

# Or run in development mode
npm run dev
```

## Configuration

Configure downstream servers in `src/registry.ts`:

```typescript
{
  id: "server-id",
  kind: "stdio",              // Only "stdio" supported (not "ws")
  command: "node",
  args: ["/path/to/server"],
  connectTimeoutMs: 8000,     // Optional
  idleTtlMs: 300000,          // 5 min idle timeout (optional)
}
```

## Gateway Tools

### 1. `discover(serverId)`
Returns metadata and tool schemas from a target server without registering them.

### 2. `dispatch(serverId, tool, args)`
Invokes a tool on a target server. Use `discover` first to see available tools.

### 3. `close(serverId)`
Manually closes a server connection and evicts it from the cache.

## Usage Example

```typescript
// 1. Discover what tools are available
discover({ serverId: "llm-memory" })

// 2. Call a tool with the correct arguments
dispatch({
  serverId: "llm-memory",
  tool: "mem.upsert",
  args: {
    type: "note",
    scope: "local",
    text: "My note"
  }
})

// 3. Optionally close the connection when done
close({ serverId: "llm-memory" })
```

## Connection Management

- **On-demand loading**: Servers spawn only when first accessed
- **Connection caching**: Active connections reused for performance
- **Automatic cleanup**: Idle connections close after 5 minutes
- **Timeout protection**: Tool calls timeout after 120 seconds

## Environment Variables

- `GATEWAY_LOG_LEVEL`: Controls logging verbosity
  - `debug`: Verbose connection and operation logs
  - `info`: Startup and errors only (default)
  - `silent`: No logs

## Adding a Custom Server

1. Add configuration to `src/registry.ts`:
   ```typescript
   {
     id: "my-server",
     kind: "stdio",
     command: "node",
     args: ["/absolute/path/to/server.js"],
     connectTimeoutMs: 8000,
     idleTtlMs: 300000,
   }
   ```

2. Ensure the downstream server is built:
   ```bash
   cd /path/to/downstream/server && npm run build
   ```

3. Rebuild and restart the gateway:
   ```bash
   npm run build
   npm start
   ```

## Client Configuration

Add to your MCP client configuration (e.g., Claude Code, Cursor):

```json
{
  "mcpServers": {
    "gateway": {
      "command": "node",
      "args": ["/path/to/gateway_mcp/dist/gateway.js"]
    }
  }
}
```

See `mcp-config-example.json` for a complete example.

## Requirements

- Node.js >= 18.0.0
- TypeScript 5.x
- @modelcontextprotocol/sdk ^1.20.0

## Limitations

- **Stdio only**: WebSocket transport not yet implemented
- **Static registry**: Server configurations are hardcoded (not dynamic)
- **No rate limiting**: Add if exposing publicly
- **No authentication**: Relies on process isolation

## Documentation

- [Design Document](./docs/design.md) (Italian) - Original design rationale and architecture
- [CLAUDE.md](./CLAUDE.md) - Development guide for Claude Code
- [MCP Specification](https://modelcontextprotocol.io/specification/latest)
- [MCP SDK Documentation](https://modelcontextprotocol.io/docs/develop/build-server)

## Troubleshooting

**Server won't connect**: Verify the path in `src/registry.ts` and ensure the downstream server is built.

**Tools not found**: Use `discover` to list available tools and verify the tool name matches exactly.

**High memory usage**: Reduce `idleTtlMs` or manually `close` servers when done.

## License

MIT
