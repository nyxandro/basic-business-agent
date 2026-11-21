-- Why a sign-in on a system's site was started (docs/specs/[20.11.2026]-mcp-connections.md, step 4): an employee
-- connects an MCP server for themselves (`connect`), or the admin checks a server with their own access (`check`).
-- What happens after the sign-in and where the browser returns depend on it. Sign-ins of plugins leave it empty.
ALTER TABLE app.oauth_states ADD COLUMN purpose text CHECK (purpose IN ('connect', 'check'));
