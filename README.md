# Prettier MCP Formatter

## 1. Requirements

- Local: Node.js 20.19+ or 24.x, plus Python 3 with `black` on `PATH`.
- Docker: Docker Engine with Compose. The image bundles Black; no Python setup is needed on the host.
- Public container image (after GitHub mirror and first successful publish): `ghcr.io/shadow7412/code-formatter:latest`.
- Pull the image with `docker pull ghcr.io/shadow7412/code-formatter:latest` once the GitHub package is public; no registry login is required.
- ChatGPT web: full custom MCP support requires Business, Enterprise, or Edu. Personal/Plus/Pro accounts only get read/fetch custom MCP servers, which cannot call `format_code`. Use Codex desktop/CLI with a bearer token instead.
- Secure MCP Tunnel: a `tunnel_id` and a runtime API key with Tunnels **Read + Use**. A personal Platform organization works; associate the tunnel with the target ChatGPT workspace.

## 2. Local setup

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install black
npm ci
npm run build
npm test
npm start                 # stdio MCP transport
```

Keep the virtual environment activated when running the server, or set `BLACK_BIN` to the
absolute path of your Black executable.

Override config with environment variables or a local `.env`.

Generate a bearer token for HTTP mode:

```sh
openssl rand -hex 32
```

## 3. Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `PRETTIER_PLUGIN_AUTO_INSTALL` | `true` | Install missing allowlisted plugins. |
| `PRETTIER_PLUGIN_ALLOWLIST` | empty | Comma-separated npm package specs. Leave versions off so bumps resolve without a redeploy. Empty blocks installs. |
| `PRETTIER_PLUGIN_CACHE` | `.cache/prettier-plugins` | Persistent cache directory. |
| `PRETTIER_PLUGIN_INSTALL_TIMEOUT` | `30000` | Install timeout in milliseconds. |
| `BLACK_BIN` | `black` | Black executable used for Python files. No shell is used. |
| `BLACK_TIMEOUT_MS` | `30000` | Black subprocess timeout in milliseconds. |
| `PRETTIER_PLUGIN_REGISTRY` | `https://registry.npmjs.org/` | Administrator-controlled registry. |
| `PRETTIER_PLUGIN_MAX_MEMORY_MB` | `4096` | Memory cap for npm. |
| `PRETTIER_PLUGIN_MAX_CPU_SECONDS` | `60` | CPU-time cap for npm. |
| `PRETTIER_ADMIN_TOKEN` | unset | Enables the `clean_plugin_cache` tool. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `MCP_HTTP_HOST` | `0.0.0.0` | HTTP bind address. |
| `MCP_HTTP_PORT` | `3072` | HTTP listen port. |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path. |
| `MCP_HTTP_TOKEN` | unset | Bearer token, minimum 16 characters. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Disables bearer auth. Use only with a private tunnel. |

`MCP_HTTP_TOKEN` and `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` are mutually exclusive.

## 4. Run with Docker

The published image includes Black on `PATH`. Do not add `BLACK_BIN` to the Compose examples
unless you are deliberately replacing the bundled executable.

### Bearer-token mode

Create `.env`:

```dotenv
MCP_HTTP_TOKEN=<openssl rand -hex 32>
PRETTIER_PLUGIN_ALLOWLIST=@prettier/plugin-xml,prettier-plugin-organize-imports,@trivago/prettier-plugin-sort-imports
```

Save as `docker-compose.yml`:

```yaml
services:
  formatter:
    image: ghcr.io/shadow7412/code-formatter:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3072:3072"
    user: "10001:10001"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs:
      - /tmp:size=64m,uid=10001,gid=10001,mode=1700
    mem_limit: 2g
    volumes:
      - ./plugin-cache:/var/cache/prettier-plugins
    environment:
      MCP_TRANSPORT: http
      MCP_HTTP_HOST: 0.0.0.0
      MCP_HTTP_PORT: "3072"
      MCP_HTTP_PATH: /mcp
      MCP_HTTP_TOKEN: ${MCP_HTTP_TOKEN:?set a long random token in .env}
      PRETTIER_PLUGIN_AUTO_INSTALL: "true"
      PRETTIER_PLUGIN_ALLOWLIST: ${PRETTIER_PLUGIN_ALLOWLIST:-}
      PRETTIER_PLUGIN_CACHE: /var/cache/prettier-plugins
      PRETTIER_PLUGIN_INSTALL_TIMEOUT: "30000"
      PRETTIER_ADMIN_TOKEN: ${PRETTIER_ADMIN_TOKEN:-}
```

Create the cache directory with the UID the container runs as, then start:

```sh
mkdir -p plugin-cache
sudo chown 10001:10001 plugin-cache
docker compose up -d
```

For a remote client, put a TLS reverse proxy in front of `127.0.0.1:3072` and send:

```http
Authorization: Bearer <MCP_HTTP_TOKEN>
```

Do not expose the no-auth endpoint through a public proxy.

### No-auth mode through Secure MCP Tunnel

Get the two `CONTROL_PLANE_*` values first:

1. Open <https://platform.openai.com/settings/organization/tunnels> and create a
   tunnel, or select an existing one. The tunnel must be associated with the
   ChatGPT workspace you'll use. Copy its ID (`tunnel_...`) into
   `CONTROL_PLANE_TUNNEL_ID`. Wait 25–30 seconds after creating it before use.
2. Open <https://platform.openai.com/settings/organization/api-keys> and create
   a **Restricted** runtime API key with Tunnels **Read** + **Use**. Copy it into
   `CONTROL_PLANE_API_KEY`. Do not use an **All** key or an admin key for the
   long-lived daemon.
3. The account that creates the key needs Tunnels **Read** + **Use** on that
   tunnel. Check <https://platform.openai.com/settings/organization/people/roles>
   if the tunnel client gets a 403 while polling.

Create a root-only `.env`:

```dotenv
CONTROL_PLANE_API_KEY=sk-...
CONTROL_PLANE_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
```

Save as `docker-compose.yml`:

```yaml
services:
  formatter:
    image: ghcr.io/shadow7412/code-formatter:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3072:3072"
    user: "10001:10001"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs:
      - /tmp:size=64m,uid=10001,gid=10001,mode=1700
    mem_limit: 2g
    volumes:
      - ./plugin-cache:/var/cache/prettier-plugins
    environment:
      MCP_TRANSPORT: http
      MCP_HTTP_HOST: 0.0.0.0
      MCP_HTTP_PORT: "3072"
      MCP_HTTP_PATH: /mcp
      MCP_HTTP_ALLOW_UNAUTHENTICATED: "true"
      PRETTIER_PLUGIN_AUTO_INSTALL: "true"
      PRETTIER_PLUGIN_ALLOWLIST: "@prettier/plugin-xml,prettier-plugin-organize-imports,@trivago/prettier-plugin-sort-imports"
      PRETTIER_PLUGIN_CACHE: /var/cache/prettier-plugins
      PRETTIER_PLUGIN_INSTALL_TIMEOUT: "30000"

  tunnel-client:
    image: ghcr.io/openai/tunnel-client:v0.0.21
    restart: unless-stopped
    depends_on:
      - formatter
    environment:
      CONTROL_PLANE_API_KEY: ${CONTROL_PLANE_API_KEY:?set in .env}
      CONTROL_PLANE_TUNNEL_ID: ${CONTROL_PLANE_TUNNEL_ID:?set in .env}
      MCP_SERVER_URL: http://formatter:3072/mcp
      MCP_OAUTH_DISCOVERY: disabled
      LOG_LEVEL: info
      LOG_FORMAT: json
      HEALTH_LISTEN_ADDR: ":8080"
    ports:
      - "127.0.0.1:8080:8080"
```

Create the cache directory with the UID the container runs as, then start both
services:

```sh
mkdir -p plugin-cache
sudo chown 10001:10001 plugin-cache
docker compose up -d
```

Check the tunnel is polling:

```sh
curl -fsS http://127.0.0.1:8080/readyz
docker compose logs -f tunnel-client
```

Do not expose port `8080` publicly; the formatter's no-auth port must stay on
loopback.

## 5. Connect clients

### ChatGPT desktop / Codex CLI / IDE extension

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.prettier_formatter]
url = "http://127.0.0.1:3072/mcp"
bearer_token_env_var = "MCP_HTTP_TOKEN"
default_tools_approval_mode = "prompt"
tool_timeout_sec = 120
```

Export `MCP_HTTP_TOKEN` before launching the client.

### ChatGPT web

1. Open <https://chatgpt.com/plugins>.
2. Select **Add custom MCP server**.
3. Under **Connection**, select **Tunnel**.
4. Choose the tunnel.
5. Set authentication to **none**.
6. Select **Create as a plugin**, then install it.
7. In a chat, type `@` and select the plugin.

ChatGPT web cannot send a static bearer token. Use a tunnel for this setup.

## 6. Verify

```sh
curl -fsS http://127.0.0.1:3072/healthz
black --version
npx @modelcontextprotocol/inspector@latest
```

In MCP Inspector, select **Streamable HTTP** and connect to
`http://127.0.0.1:3072/mcp`.
