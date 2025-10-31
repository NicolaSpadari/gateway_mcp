#!/usr/bin/env bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory (where gateway_mcp is located)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo -e "${BLUE}=== MCP Gateway Uninstall Script ===${NC}\n"

# Check if Claude CLI is available
CLAUDE_CMD=""
USE_DIRECT_CONFIG=false

# Try common locations for Claude CLI
if [[ -f "$HOME/.claude/local/claude" ]]; then
    CLAUDE_CMD="$HOME/.claude/local/claude --dangerously-skip-permissions"
elif command -v claude &> /dev/null; then
    CLAUDE_CMD="claude"
else
    echo -e "${YELLOW}⚠ Claude CLI not found, will update config file directly${NC}"
    USE_DIRECT_CONFIG=true
fi

# Remove gateway from Claude Code config
echo -e "\n${BLUE}Removing gateway from Claude Code configuration...${NC}"

if [[ "$USE_DIRECT_CONFIG" == true ]]; then
    # Direct config file manipulation
    CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

    if [[ ! -f "$CLAUDE_CONFIG" ]]; then
        echo -e "${YELLOW}Claude Code config not found. Nothing to uninstall.${NC}"
        exit 0
    fi

    node <<EOF
const fs = require('fs');
const configPath = '$CLAUDE_CONFIG';

try {
    const content = fs.readFileSync(configPath, 'utf8');
    let config = JSON.parse(content);

    if (config.mcpServers && config.mcpServers.gateway) {
        delete config.mcpServers.gateway;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('✓ Gateway removed from Claude Code configuration');
    } else {
        console.log('Gateway was not found in configuration');
    }
} catch (err) {
    console.error('Error updating configuration:', err.message);
    process.exit(1);
}
EOF
else
    # Use Claude CLI
    if $CLAUDE_CMD mcp remove gateway 2>/dev/null; then
        echo -e "${GREEN}✓ Gateway removed from Claude Code configuration${NC}"
    else
        echo -e "${YELLOW}Note: Gateway may not be configured${NC}"
    fi
fi

echo -e "${GREEN}Uninstall complete!${NC}"
echo
echo -e "${YELLOW}Note:${NC}"
echo "- The gateway directory has NOT been deleted: $SCRIPT_DIR"
echo "- The registry.config.json has NOT been deleted"
echo "- Downstream MCP servers have NOT been affected"
echo "- Restart Claude Code for changes to take effect"
echo
echo -e "To completely remove the gateway, manually delete: ${BLUE}$SCRIPT_DIR${NC}"
