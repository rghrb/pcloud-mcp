import { timingSafeEqual } from "node:crypto";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "./config.js";
import { createOAuthProvider } from "./oauth.js";
import { homePage, implicitCallbackPage, setupPage } from "./pages.js";
import {
  exchangePCloudCode,
  hostnameFromLocation,
  PCloudClient,
  probeHostname,
  resolveWorkingClient
} from "./pcloud.js";
import { loadJson, pcloudCredsPath, saveJson, type PCloudCreds } from "./store.js";
import { createPCloudMcpServer } from "./server.js";

function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id, WWW-Authenticate");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function bearerEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createHttpApp(config: AppConfig): Promise<express.Express> {
  const app = express();
  app.set("trust proxy", true);
  app.use(cors);
  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  const issuerUrl = new URL(config.publicUrl);
  const mcpUrl = new URL("/mcp", `${config.publicUrl}/`);
  const oauth = createOAuthProvider(config.dataDir, config.connectorPassword);

  let cached: { fingerprint: string; creds: PCloudCreds; client: PCloudClient } | undefined;

  const loadCreds = async (): Promise<PCloudCreds[]> => {
    const saved = await loadJson<PCloudCreds | undefined>(
      pcloudCredsPath(config.dataDir),
      undefined
    );
    const envToken = config.pcloudAccessToken?.trim();
    const fromEnv: PCloudCreds | undefined = envToken
      ? { access_token: envToken, hostname: config.pcloudApiHost }
      : undefined;
    // /setup writes a validated token to disk. A stale PCLOUD_ACCESS_TOKEN in
    // the host env must not override it — that is the usual 2094 failure.
    return [saved, fromEnv].filter((value): value is PCloudCreds => Boolean(value?.access_token));
  };

  const getClient = async () => {
    const candidates = await loadCreds();
    const fingerprint = candidates.map((c) => `${c.hostname}:${c.access_token}`).join("|");
    if (cached?.fingerprint === fingerprint) return cached.client;
    const resolved = await resolveWorkingClient(candidates);
    saveJson(pcloudCredsPath(config.dataDir), resolved.creds);
    cached = { fingerprint, ...resolved };
    return resolved.client;
  };

  const handleMcp = async (req: Request, res: Response) => {
    const server = createPCloudMcpServer(getClient, config.readFileMaxBytes);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  if (config.authMode === "oauth") {
    if (issuerUrl.protocol !== "https:" && issuerUrl.hostname !== "localhost" && issuerUrl.hostname !== "127.0.0.1") {
      process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = "true";
      console.warn(
        "PUBLIC_URL is not HTTPS. Grok iOS requires a public https:// URL. Set PUBLIC_URL to your https origin."
      );
    }
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl,
        baseUrl: issuerUrl,
        resourceServerUrl: mcpUrl,
        scopesSupported: ["mcp:tools"],
        resourceName: "pCloud MCP",
        serviceDocumentationUrl: new URL("https://github.com/rghrb/pcloud-mcp"),
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 }
      })
    );
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
      res.json({
        resource: mcpUrl.href,
        authorization_servers: [issuerUrl.href],
        scopes_supported: ["mcp:tools"],
        resource_name: "pCloud MCP"
      });
    });
    app.get("/oauth/consent", (req, res) => {
      void oauth.renderConsent(req, res);
    });
    app.post("/oauth/consent", (req, res) => {
      void oauth.handleConsent(req, res);
    });
    const auth = requireBearerAuth({
      verifier: oauth,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl)
    });
    app.all("/mcp", auth, (req, res) => {
      void handleMcp(req, res);
    });
  } else if (config.authMode === "bearer") {
    const expected = config.mcpAuthToken;
    if (!expected) {
      throw new Error("AUTH_MODE=bearer requires MCP_AUTH_TOKEN");
    }
    app.all("/mcp", (req, res, next) => {
      const header = req.header("authorization") || "";
      const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      if (!token || !bearerEqual(token, expected)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="pcloud-mcp"');
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      (req as Request & { auth?: AuthInfo }).auth = {
        token,
        clientId: "bearer",
        scopes: ["mcp:tools"]
      };
      next();
    }, (req, res) => {
      void handleMcp(req, res);
    });
  } else {
    app.all("/mcp", (req, res) => {
      void handleMcp(req, res);
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", async (_req, res) => {
    const candidates = await loadCreds();
    const creds = candidates[0];
    res.type("html").send(
      homePage({
        publicUrl: config.publicUrl,
        pcloudConnected: Boolean(creds?.access_token),
        pcloudEmail: creds?.email,
        pcloudHost: creds?.hostname,
        authMode: config.authMode
      })
    );
  });

  app.get("/setup", (_req, res) => {
    res.type("html").send(
      setupPage({
        hasClient: Boolean(config.pcloudClientId && config.pcloudClientSecret)
      })
    );
  });

  app.post("/setup/token", async (req, res) => {
    const token = String(req.body?.token || "").trim();
    const region = String(req.body?.region || "auto");
    if (!token) {
      res.status(400).type("html").send(setupPage({ hasClient: Boolean(config.pcloudClientId), error: "Token is required." }));
      return;
    }
    const preferred =
      region === "eu" ? "eapi.pcloud.com" : region === "us" ? "api.pcloud.com" : config.pcloudApiHost;
    try {
      const probed = await probeHostname(token, preferred);
      const creds: PCloudCreds = {
        access_token: token,
        hostname: probed.hostname,
        uid: Number(probed.userinfo.userid || 0) || undefined,
        email: String(probed.userinfo.email || "") || undefined
      };
      saveJson(pcloudCredsPath(config.dataDir), creds);
      cached = undefined;
      res.type("html").send(
        setupPage({
          hasClient: Boolean(config.pcloudClientId),
          message: `Connected as ${creds.email || "pCloud user"} on ${creds.hostname}.`
        })
      );
    } catch (error) {
      res.status(400).type("html").send(
        setupPage({
          hasClient: Boolean(config.pcloudClientId),
          error: error instanceof Error ? error.message : "Token check failed."
        })
      );
    }
  });

  app.post("/setup/oauth", (req, res) => {
    if (!config.pcloudClientId || !config.pcloudClientSecret) {
      res.status(400).type("html").send(
        setupPage({ hasClient: false, error: "Set PCLOUD_CLIENT_ID and PCLOUD_CLIENT_SECRET first." })
      );
      return;
    }
    const url = new URL("https://my.pcloud.com/oauth2/authorize");
    url.searchParams.set("client_id", config.pcloudClientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", `${config.publicUrl}/setup/callback`);
    res.redirect(url.toString());
  });

  app.get("/setup/callback", async (req, res) => {
    const code = String(req.query.code || "");
    if (!code) {
      res.type("html").send(implicitCallbackPage());
      return;
    }
    if (!config.pcloudClientId || !config.pcloudClientSecret) {
      res.status(400).type("html").send(
        setupPage({
          hasClient: false,
          error: "Got an OAuth code, but PCLOUD_CLIENT_ID / PCLOUD_CLIENT_SECRET are not set on the server."
        })
      );
      return;
    }
    try {
      const creds = await exchangePCloudCode({
        clientId: config.pcloudClientId,
        clientSecret: config.pcloudClientSecret,
        code,
        hostname: hostnameFromLocation(
          String(req.query.locationid || ""),
          String(req.query.hostname || "")
        )
      });
      saveJson(pcloudCredsPath(config.dataDir), creds);
      cached = undefined;
      res.type("html").send(
        setupPage({
          hasClient: true,
          message: `Connected as ${creds.email || "pCloud user"} on ${creds.hostname}.`
        })
      );
    } catch (error) {
      res.status(400).type("html").send(
        setupPage({
          hasClient: true,
          error: error instanceof Error ? error.message : "OAuth exchange failed."
        })
      );
    }
  });

  return app;
}
