# pCloud MCP

A hostable [Model Context Protocol](https://modelcontextprotocol.io) server for [pCloud](https://www.pcloud.com). After you deploy it on a public HTTPS URL, Grok, Grokbot iOS, Claude, and other MCP clients can browse, read, write, and share files in your pCloud account.

**MCP URL after deploy:** `https://YOUR_HOST/mcp`

## What it exposes

| Tool | Purpose |
| --- | --- |
| `list_folder` | List a folder (root is `folderid` `0` or path `/`) |
| `get_metadata` | File or folder metadata |
| `read_file` | Read text inline; binary files get a temporary download URL |
| `write_file` | Upload UTF-8 or base64 content |
| `get_download_link` | Temporary non-public download URL |
| `create_folder` | Create a folder |
| `delete_file` / `delete_folder` | Trash a file or folder |
| `rename` / `move` | Rename in place or move by destination path |
| `copy_file` / `copy_folder` | Copy into another folder |
| `search` | Name search under a folder tree |
| `create_public_link` / `list_public_links` / `delete_public_link` | Public share links |
| `get_account` | Email, quota, used space |
| `list_trash` / `restore_trash` | Trash |

Grok iOS and Grokbot talk to **your** server over HTTPS. Your pCloud token stays on the server. Clients sign in to the connector with a password you set (`CONNECTOR_PASSWORD`).

## Quick start (local)

```bash
git clone https://github.com/rghrb/pcloud-mcp.git
cd pcloud-mcp
npm install
cp .env.example .env
# edit .env: at least PCLOUD_ACCESS_TOKEN or connect via /setup
npm run build
npm start
```

Open http://127.0.0.1:3847/setup, paste a pCloud access token, then point a local MCP client at `http://127.0.0.1:3847/mcp`.

Grok and Grokbot iOS **cannot** use localhost. Deploy with HTTPS, then add `https://YOUR_HOST/mcp`.

## Connect pCloud

Pick one:

### A. Paste an access token (fastest)

1. Create an app at [pCloud My Apps](https://docs.pcloud.com/my_apps/).
2. Add redirect URI `https://YOUR_HOST/setup/callback` and allow implicit grant.
3. Open this URL (no space after `client_id=`, and `redirect_uri` is required for `response_type=token`):

   `https://my.pcloud.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&response_type=token&redirect_uri=https://YOUR_HOST/setup/callback`

4. pCloud sends you back to `/setup/callback`. This server reads the token from the URL and saves it.
5. Set `PCLOUD_API_HOST=eapi.pcloud.com` for EU accounts, `api.pcloud.com` for US, if auto-detect is wrong.

### B. OAuth from the server

1. Create an app at [pCloud My Apps](https://docs.pcloud.com/my_apps/).
2. Add redirect URI `https://YOUR_HOST/setup/callback`.
3. Set `PCLOUD_CLIENT_ID` and `PCLOUD_CLIENT_SECRET`.
4. Open `https://YOUR_HOST/setup` and click **Connect with pCloud**.

pCloud access tokens do not expire until you revoke them.

## Host it

The container listens on port `3847` (3000 is a common conflict). Persist `/data` so OAuth clients and the pCloud token survive restarts. Override with `PORT` if you need a different one.

### Docker Compose

```bash
cp .env.example .env
# fill CONNECTOR_PASSWORD, PUBLIC_URL, and pCloud token or app credentials
docker compose up --build -d
```

```yaml
# docker-compose.yml is in the repo
```

### Render / Railway / Fly / any Node host

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | yes in production | Public origin, e.g. `https://pcloud-mcp.example.com` (no trailing slash) |
| `CONNECTOR_PASSWORD` | recommended | Password Grok shows when connecting |
| `AUTH_MODE` | no (default `oauth`) | `oauth`, `bearer`, or `none` |
| `PCLOUD_ACCESS_TOKEN` | one of token or `/setup` | pCloud bearer token |
| `PCLOUD_API_HOST` | no | `api.pcloud.com` (US) or `eapi.pcloud.com` (EU) |
| `PCLOUD_CLIENT_ID` / `PCLOUD_CLIENT_SECRET` | for `/setup` OAuth | From pCloud My Apps |
| `MCP_AUTH_TOKEN` | if `AUTH_MODE=bearer` | Static bearer token |
| `DATA_DIR` | no | Default `./data` |
| `PORT` | no | Default `3847` |

If `CONNECTOR_PASSWORD` is unset, the server writes a random one to `data/connector-password.txt` on first start.

`PUBLIC_URL` is also picked up from `RENDER_EXTERNAL_URL`, `RAILWAY_PUBLIC_DOMAIN`, or `FLY_APP_NAME` when those platforms set them.

### Docker

```bash
docker build -t pcloud-mcp .
docker run --rm -p 3847:3847 \
  -e PUBLIC_URL=https://YOUR_HOST \
  -e CONNECTOR_PASSWORD='pick-a-long-password' \
  -e PCLOUD_ACCESS_TOKEN='...' \
  -e PCLOUD_API_HOST=eapi.pcloud.com \
  -v pcloud-mcp-data:/data \
  pcloud-mcp
```

## Connect Grok iOS / grok.com

1. Deploy this server with a public `https://` URL.
2. Finish `/setup` so pCloud is connected.
3. On the phone or web: [grok.com/connectors](https://grok.com/connectors) → **New Connector** → **Custom**.
4. Server URL: `https://YOUR_HOST/mcp`
5. Sign in with `CONNECTOR_PASSWORD` (or the generated file in `data/connector-password.txt`).

Grok discovers OAuth 2.1 + PKCE + dynamic client registration on this server. That is the flow the iOS app expects.

## Connect Grokbot iOS

Ask the bot to add a custom remote MCP server at `https://YOUR_HOST/mcp`, then complete the connect card with the same connector password.

## Grok Build / other local agents

Remote:

```bash
grok mcp add --transport http pcloud https://YOUR_HOST/mcp
```

Local stdio (no HTTP, token in the environment):

```bash
export PCLOUD_ACCESS_TOKEN=...
export PCLOUD_API_HOST=eapi.pcloud.com   # if EU
grok mcp add pcloud -- node /path/to/pcloud-mcp/dist/index.js --stdio
```

## Auth modes

- **`oauth` (default, use this for Grok / Grokbot iOS)** — unauthenticated `/mcp` returns `401` plus OAuth metadata. Clients register themselves and you approve with the connector password.
- **`bearer`** — require `Authorization: Bearer $MCP_AUTH_TOKEN`. Useful for Grok Build headers.
- **`none`** — open `/mcp`. Only use this behind something else that already authenticates, or on a secret URL you accept as the secret.

## Development

```bash
npm install
npm run dev
```

```bash
npm run build
npm start
```

## License

MIT
