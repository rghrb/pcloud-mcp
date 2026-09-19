import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type AuthMode = "oauth" | "bearer" | "none";

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function detectPublicUrl(port: number): string {
  const explicit = process.env.PUBLIC_URL;
  if (explicit) return stripSlash(explicit);
  if (process.env.RENDER_EXTERNAL_URL) return stripSlash(process.env.RENDER_EXTERNAL_URL);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return `http://127.0.0.1:${port}`;
}

function readOrCreateSecret(file: string, bytes = 24): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(bytes).toString("base64url");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export interface AppConfig {
  port: number;
  publicUrl: string;
  dataDir: string;
  authMode: AuthMode;
  connectorPassword: string;
  mcpAuthToken: string | undefined;
  pcloudAccessToken: string | undefined;
  pcloudApiHost: string;
  pcloudClientId: string | undefined;
  pcloudClientSecret: string | undefined;
  readFileMaxBytes: number;
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const port = Number(process.env.PORT || 3000);
  const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  const authMode = (process.env.AUTH_MODE || "oauth").toLowerCase() as AuthMode;
  if (!["oauth", "bearer", "none"].includes(authMode)) {
    throw new Error(`Invalid AUTH_MODE: ${authMode}. Use oauth, bearer, or none.`);
  }

  const connectorPassword =
    process.env.CONNECTOR_PASSWORD ||
    readOrCreateSecret(join(dataDir, "connector-password.txt"));

  return {
    port,
    publicUrl: detectPublicUrl(port),
    dataDir,
    authMode,
    connectorPassword,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN || undefined,
    pcloudAccessToken: process.env.PCLOUD_ACCESS_TOKEN || undefined,
    pcloudApiHost: (process.env.PCLOUD_API_HOST || "api.pcloud.com").replace(
      /^https?:\/\//,
      ""
    ),
    pcloudClientId: process.env.PCLOUD_CLIENT_ID || undefined,
    pcloudClientSecret: process.env.PCLOUD_CLIENT_SECRET || undefined,
    readFileMaxBytes: Number(process.env.READ_FILE_MAX_BYTES || 1_000_000)
  };
}
