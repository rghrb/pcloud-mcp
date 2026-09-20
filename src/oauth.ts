import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type {
  OAuthRegisteredClientsStore
} from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { consentPage } from "./pages.js";
import { loadJson, oauthStorePath, saveJson } from "./store.js";

const ACCESS_TTL_SEC = 7 * 24 * 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  resource?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: {
    state?: string;
    scopes?: string[];
    codeChallenge: string;
    redirectUri: string;
    resource?: string;
  };
  expiresAt: number;
}

interface OAuthDisk {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, StoredCode>;
  tokens: Record<string, StoredToken>;
  pending: Record<string, PendingAuth>;
}

function now(): number {
  return Date.now();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    if (left.length) timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function prune(data: OAuthDisk): void {
  const t = now();
  for (const [id, code] of Object.entries(data.codes)) {
    if (code.expiresAt < t) delete data.codes[id];
  }
  for (const [id, pending] of Object.entries(data.pending)) {
    if (pending.expiresAt < t) delete data.pending[id];
  }
  for (const [id, token] of Object.entries(data.tokens)) {
    if (token.refreshExpiresAt < t) delete data.tokens[id];
  }
}

export class FileOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private data: OAuthDisk = { clients: {}, codes: {}, tokens: {}, pending: {} };
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly connectorPassword: string
  ) {
    const self = this;
    this.clientsStore = {
      async getClient(clientId: string) {
        await self.ensureLoaded();
        return self.data.clients[clientId];
      },
      async registerClient(client) {
        await self.ensureLoaded();
        const incoming = client as OAuthClientInformationFull;
        const full: OAuthClientInformationFull = {
          ...incoming,
          client_id: incoming.client_id || randomUUID(),
          client_id_issued_at: incoming.client_id_issued_at ?? Math.floor(Date.now() / 1000)
        };
        self.data.clients[full.client_id] = full;
        self.persist();
        return full;
      }
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.data = await loadJson<OAuthDisk>(this.path, {
      clients: {},
      codes: {},
      tokens: {},
      pending: {}
    });
    prune(this.data);
    this.loaded = true;
  }

  private persist(): void {
    prune(this.data);
    saveJson(this.path, this.data);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    await this.ensureLoaded();
    const pendingId = randomUUID();
    this.data.pending[pendingId] = {
      client,
      params: {
        state: params.state,
        scopes: params.scopes,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: params.resource?.toString()
      },
      expiresAt: now() + CODE_TTL_MS
    };
    this.persist();
    res.redirect(`/oauth/consent?pending=${encodeURIComponent(pendingId)}`);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    await this.ensureLoaded();
    const code = this.data.codes[authorizationCode];
    if (!code || code.clientId !== client.client_id || code.expiresAt < now()) {
      throw new Error("Invalid authorization code");
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    await this.ensureLoaded();
    const code = this.data.codes[authorizationCode];
    if (!code || code.clientId !== client.client_id || code.expiresAt < now()) {
      throw new Error("Invalid authorization code");
    }
    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new Error("redirect_uri mismatch");
    }
    delete this.data.codes[authorizationCode];
    return this.issueTokens(client.client_id, code.scopes, code.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    await this.ensureLoaded();
    const existing = Object.values(this.data.tokens).find(
      (token) => token.refreshToken === refreshToken && token.clientId === client.client_id
    );
    if (!existing || existing.refreshExpiresAt < now()) {
      throw new Error("Invalid refresh token");
    }
    for (const [id, token] of Object.entries(this.data.tokens)) {
      if (token.refreshToken === refreshToken) delete this.data.tokens[id];
    }
    const nextScopes = scopes?.length ? scopes : existing.scopes;
    return this.issueTokens(client.client_id, nextScopes, existing.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    await this.ensureLoaded();
    const found = Object.values(this.data.tokens).find((row) => row.accessToken === token);
    if (!found || found.accessExpiresAt < now()) {
      throw new Error("Invalid or expired token");
    }
    return {
      token,
      clientId: found.clientId,
      scopes: found.scopes,
      expiresAt: Math.floor(found.accessExpiresAt / 1000),
      resource: found.resource ? new URL(found.resource) : undefined
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    await this.ensureLoaded();
    for (const [id, token] of Object.entries(this.data.tokens)) {
      if (token.clientId !== client.client_id) continue;
      if (token.accessToken === request.token || token.refreshToken === request.token) {
        delete this.data.tokens[id];
      }
    }
    this.persist();
  }

  async renderConsent(req: Request, res: Response): Promise<void> {
    await this.ensureLoaded();
    const pendingId = String(req.query.pending || "");
    const pending = this.data.pending[pendingId];
    if (!pending || pending.expiresAt < now()) {
      res.status(400).send(consentPage({
        pendingId: "",
        clientName: "Unknown client",
        error: "This authorization request expired. Start the connect flow again from Grok."
      }));
      return;
    }
    res.send(
      consentPage({
        pendingId,
        clientName: pending.client.client_name || pending.client.client_id
      })
    );
  }

  async handleConsent(req: Request, res: Response): Promise<void> {
    await this.ensureLoaded();
    const pendingId = String(req.body?.pending || "");
    const password = String(req.body?.password || "");
    const pending = this.data.pending[pendingId];
    if (!pending || pending.expiresAt < now()) {
      res.status(400).send(
        consentPage({
          pendingId,
          clientName: "Unknown client",
          error: "This authorization request expired. Start the connect flow again from Grok."
        })
      );
      return;
    }
    if (!safeEqual(password, this.connectorPassword)) {
      res.status(401).send(
        consentPage({
          pendingId,
          clientName: pending.client.client_name || pending.client.client_id,
          error: "Wrong connector password."
        })
      );
      return;
    }

    const code = randomBytes(24).toString("base64url");
    this.data.codes[code] = {
      clientId: pending.client.client_id,
      redirectUri: pending.params.redirectUri,
      codeChallenge: pending.params.codeChallenge,
      scopes: pending.params.scopes?.length ? pending.params.scopes : ["mcp:tools"],
      resource: pending.params.resource,
      expiresAt: now() + CODE_TTL_MS
    };
    delete this.data.pending[pendingId];
    this.persist();

    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    res.redirect(redirect.toString());
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string
  ): OAuthTokens {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const id = randomUUID();
    this.data.tokens[id] = {
      clientId,
      scopes,
      resource,
      accessToken,
      refreshToken,
      accessExpiresAt: now() + ACCESS_TTL_SEC * 1000,
      refreshExpiresAt: now() + REFRESH_TTL_MS
    };
    this.persist();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(" ")
    };
  }
}

export function createOAuthProvider(dataDir: string, connectorPassword: string): FileOAuthProvider {
  return new FileOAuthProvider(oauthStorePath(dataDir), connectorPassword);
}
