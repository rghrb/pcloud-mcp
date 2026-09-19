function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
      background: #0e141b;
      color: #e7eef6;
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 20px 80px;
    }
    h1 { font-size: 1.6rem; margin: 0 0 8px; letter-spacing: -0.03em; }
    p, li { color: #b7c4d2; }
    a { color: #8ec8ff; }
    .card {
      background: #17202a;
      border: 1px solid #2a3846;
      border-radius: 16px;
      padding: 22px;
      margin: 20px 0;
    }
    code, kbd {
      font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #0e141b;
      padding: 1px 6px;
      border-radius: 6px;
    }
    pre {
      overflow: auto;
      background: #0e141b;
      border-radius: 12px;
      padding: 14px;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    label { display: block; margin: 12px 0 6px; color: #d5e0ea; }
    input, select, textarea {
      width: 100%;
      border: 1px solid #334556;
      background: #0e141b;
      color: inherit;
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
    }
    button, .btn {
      display: inline-block;
      margin-top: 16px;
      background: #3b82f6;
      color: white;
      border: 0;
      border-radius: 999px;
      padding: 10px 18px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    .muted { color: #8b9aab; font-size: 0.92rem; }
    .ok { color: #86efac; }
    .err { color: #fca5a5; }
    .pill {
      display: inline-block;
      border: 1px solid #334556;
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 12px;
      color: #c5d3e0;
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

export function homePage(opts: {
  publicUrl: string;
  pcloudConnected: boolean;
  pcloudEmail?: string;
  pcloudHost?: string;
  authMode: string;
}): string {
  const mcpUrl = `${opts.publicUrl}/mcp`;
  const status = opts.pcloudConnected
    ? `<p class="ok">pCloud is connected${opts.pcloudEmail ? ` as ${escapeHtml(opts.pcloudEmail)}` : ""}${opts.pcloudHost ? ` via <code>${escapeHtml(opts.pcloudHost)}</code>` : ""}.</p>`
    : `<p class="err">pCloud is not connected yet. Open <a href="/setup">/setup</a> first.</p>`;

  return shell(
    "pCloud MCP",
    `
    <p class="pill">pCloud MCP connector</p>
    <h1>Connect Grok to your pCloud</h1>
    <p>This host exposes a remote Model Context Protocol server. Grok, Grokbot, Claude, and other MCP clients can use it to list, read, write, and share files in your pCloud.</p>
    ${status}
    <div class="card">
      <h2>MCP URL</h2>
      <pre>${escapeHtml(mcpUrl)}</pre>
      <p class="muted">Auth mode: <code>${escapeHtml(opts.authMode)}</code>. For Grok and Grokbot iOS, keep <code>AUTH_MODE=oauth</code> and complete the sign-in prompt with your connector password.</p>
    </div>
    <div class="card">
      <h2>Grok iOS / grok.com</h2>
      <ol>
        <li>Open <a href="https://grok.com/connectors">grok.com/connectors</a> (same connectors list is in the Grok iOS app).</li>
        <li>New Connector → Custom.</li>
        <li>Paste <code>${escapeHtml(mcpUrl)}</code>.</li>
        <li>When asked to sign in, enter the connector password from your server env / <code>data/connector-password.txt</code>.</li>
      </ol>
    </div>
    <div class="card">
      <h2>Grokbot iOS</h2>
      <p>Ask the bot to add a custom remote MCP server at <code>${escapeHtml(mcpUrl)}</code>, then complete the connect card.</p>
    </div>
    <p><a class="btn" href="/setup">Set up pCloud</a></p>
    `
  );
}

export function setupPage(opts: {
  hasClient: boolean;
  message?: string;
  error?: string;
}): string {
  const oauthBlock = opts.hasClient
    ? `<form method="post" action="/setup/oauth">
         <p>Authorize this server against your pCloud account using the app credentials in the environment.</p>
         <button type="submit">Connect with pCloud</button>
       </form>`
    : `<p class="muted">To use the pCloud OAuth button, set <code>PCLOUD_CLIENT_ID</code> and <code>PCLOUD_CLIENT_SECRET</code> from <a href="https://docs.pcloud.com/my_apps/">pCloud My Apps</a>, with redirect URI <code>/setup/callback</code>.</p>`;

  return shell(
    "Connect pCloud",
    `
    <p><a href="/">← Home</a></p>
    <h1>Connect pCloud</h1>
    ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
    ${opts.message ? `<p class="ok">${escapeHtml(opts.message)}</p>` : ""}
    <div class="card">
      <h2>Paste an access token</h2>
      <form method="post" action="/setup/token">
        <label for="token">Access token</label>
        <textarea id="token" name="token" rows="3" required></textarea>
        <label for="region">Data region</label>
        <select id="region" name="region">
          <option value="auto">Auto-detect</option>
          <option value="us">United States (api.pcloud.com)</option>
          <option value="eu">Europe (eapi.pcloud.com)</option>
        </select>
        <button type="submit">Save token</button>
      </form>
    </div>
    <div class="card">
      <h2>OAuth</h2>
      ${oauthBlock}
    </div>
    `
  );
}

export function implicitCallbackPage(): string {
  return shell(
    "Saving pCloud token",
    `
    <h1>Connecting pCloud</h1>
    <p id="status">Saving the access token from pCloud…</p>
    <form id="save" method="post" action="/setup/token">
      <input type="hidden" name="token" />
      <input type="hidden" name="region" value="auto" />
    </form>
    <script>
      (function () {
        var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        var token = params.get("access_token");
        var hostname = params.get("hostname") || "";
        var locationid = params.get("locationid") || "";
        var status = document.getElementById("status");
        if (!token) {
          status.textContent = "No access token in the redirect. Start again from /setup.";
          status.className = "err";
          return;
        }
        var region = "auto";
        if (hostname.indexOf("eapi.") === 0 || locationid === "2") region = "eu";
        else if (hostname.indexOf("api.") === 0 || locationid === "1") region = "us";
        var form = document.getElementById("save");
        form.token.value = token;
        form.region.value = region;
        form.submit();
      })();
    </script>
    `
  );
}

export function consentPage(opts: {
  pendingId: string;
  clientName: string;
  error?: string;
}): string {
  return shell(
    "Authorize pCloud MCP",
    `
    <h1>Authorize Grok</h1>
    <p><strong>${escapeHtml(opts.clientName)}</strong> wants to use this pCloud connector.</p>
    ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
    <div class="card">
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="pending" value="${escapeHtml(opts.pendingId)}" />
        <label for="password">Connector password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
        <p class="muted">This is the password for <em>this server</em>, not your pCloud login. It lives in <code>CONNECTOR_PASSWORD</code> or <code>data/connector-password.txt</code>.</p>
        <button type="submit">Allow access</button>
      </form>
    </div>
    `
  );
}
