import type { PCloudCreds } from "./store.js";

const ERRORS: Record<number, string> = {
  1000: "Log in required.",
  1002: "No path or folder id provided.",
  1004: "No file id or path provided.",
  2000: "Log in failed. Check the pCloud access token and API host.",
  2001: "Invalid file or folder name.",
  2003: "Access denied.",
  2005: "Directory does not exist.",
  2008: "Account is over quota.",
  2009: "File not found.",
  2010: "Invalid path.",
  2094: "Invalid access_token. Use the EU host eapi.pcloud.com or the US host api.pcloud.com, and reconnect at /setup if a stale PCLOUD_ACCESS_TOKEN is set.",
  4000: "Too many login tries from this IP."
};

export class PCloudError extends Error {
  constructor(
    public readonly result: number,
    message?: string
  ) {
    super(message || ERRORS[result] || `pCloud API error ${result}`);
    this.name = "PCloudError";
  }
}

export type JsonMap = Record<string, unknown>;

export class PCloudClient {
  constructor(
    public accessToken: string,
    public hostname: string
  ) {}

  private apiUrl(method: string, params: Record<string, string | number | undefined> = {}): URL {
    const url = new URL(`https://${this.hostname}/${method}`);
    url.searchParams.set("access_token", this.accessToken);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async call(method: string, params: Record<string, string | number | undefined> = {}): Promise<JsonMap> {
    const url = this.apiUrl(method, params);
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(`pCloud HTTP ${res.status} calling ${method}`);
    }
    const json = (await res.json()) as JsonMap;
    const result = Number(json.result ?? 0);
    if (result !== 0) throw new PCloudError(result);
    return json;
  }

  async upload(opts: {
    filename: string;
    body: Buffer;
    folderid?: number;
    path?: string;
    renameifexists?: boolean;
  }): Promise<JsonMap> {
    const params: Record<string, string | number | undefined> = {
      nopartial: 1,
      folderid: opts.folderid,
      path: opts.path
    };
    if (opts.renameifexists) params.renameifexists = 1;
    const url = this.apiUrl("uploadfile", params);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(opts.body)]), opts.filename);
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`pCloud HTTP ${res.status} uploading ${opts.filename}`);
    const json = (await res.json()) as JsonMap;
    const result = Number(json.result ?? 0);
    if (result !== 0) throw new PCloudError(result);
    return json;
  }

  async downloadLink(params: { fileid?: number; path?: string }): Promise<{
    url: string;
    expires?: string;
  }> {
    const json = await this.call("getfilelink", params);
    const hosts = json.hosts as string[] | undefined;
    const path = json.path as string | undefined;
    if (!hosts?.length || !path) throw new Error("pCloud did not return a download link");
    return {
      url: `https://${hosts[0]}${path}`,
      expires: json.expires as string | undefined
    };
  }

  async readBytes(params: { fileid?: number; path?: string }, maxBytes: number): Promise<{
    bytes: Buffer;
    contentType: string | undefined;
    truncated: boolean;
  }> {
    const { url } = await this.downloadLink(params);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > maxBytes;
    return {
      bytes: truncated ? buf.subarray(0, maxBytes) : buf,
      contentType: res.headers.get("content-type") || undefined,
      truncated
    };
  }
}

export async function resolveWorkingClient(
  candidates: Array<PCloudCreds | undefined>
): Promise<{ client: PCloudClient; creds: PCloudCreds }> {
  const seen = new Set<string>();
  const tries: PCloudCreds[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const token = candidate.access_token?.trim();
    if (!token) continue;
    const hosts = [candidate.hostname, "eapi.pcloud.com", "api.pcloud.com"].filter(
      (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index
    );
    for (const hostname of hosts) {
      const key = `${hostname}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tries.push({ ...candidate, access_token: token, hostname });
    }
  }
  if (!tries.length) {
    throw new Error("pCloud is not connected. Open /setup on this server and add an access token.");
  }

  let lastError: unknown;
  for (const creds of tries) {
    try {
      const client = new PCloudClient(creds.access_token, creds.hostname);
      const userinfo = await client.call("userinfo");
      return {
        client,
        creds: {
          access_token: creds.access_token,
          hostname: creds.hostname,
          uid: Number(userinfo.userid || creds.uid || 0) || undefined,
          email: String(userinfo.email || creds.email || "") || undefined
        }
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof PCloudError && lastError.result === 2094) {
    throw new PCloudError(
      2094,
      "pCloud rejected the access token on both eapi.pcloud.com and api.pcloud.com. Remove a stale PCLOUD_ACCESS_TOKEN from the host env and reconnect at /setup."
    );
  }
  throw lastError instanceof Error ? lastError : new Error("Could not reach pCloud");
}

export async function probeHostname(
  accessToken: string,
  preferred?: string
): Promise<{ hostname: string; userinfo: JsonMap }> {
  const resolved = await resolveWorkingClient([
    { access_token: accessToken, hostname: preferred || "" }
  ]);
  return {
    hostname: resolved.creds.hostname,
    userinfo: { email: resolved.creds.email, userid: resolved.creds.uid }
  };
}

export function hostnameFromLocation(locationid?: string | number, hostname?: string): string {
  if (hostname) return hostname.replace(/^https?:\/\//, "");
  if (String(locationid) === "2") return "eapi.pcloud.com";
  return "api.pcloud.com";
}

export async function exchangePCloudCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  hostname?: string;
}): Promise<PCloudCreds> {
  const hosts = opts.hostname
    ? [opts.hostname]
    : ["api.pcloud.com", "eapi.pcloud.com"];
  let lastError: unknown;
  for (const host of hosts) {
    const url = new URL(`https://${host}/oauth2_token`);
    url.searchParams.set("client_id", opts.clientId);
    url.searchParams.set("client_secret", opts.clientSecret);
    url.searchParams.set("code", opts.code);
    try {
      const res = await fetch(url);
      const json = (await res.json()) as JsonMap;
      if (Number(json.result ?? 0) !== 0) {
        lastError = new PCloudError(Number(json.result), String(json.error || ""));
        continue;
      }
      const access_token = String(json.access_token || "");
      if (!access_token) throw new Error("pCloud oauth2_token returned no access_token");
      const probed = await probeHostname(access_token, opts.hostname || host);
      return {
        access_token,
        hostname: probed.hostname,
        uid: Number(json.uid || probed.userinfo.userid || 0) || undefined,
        email: String(probed.userinfo.email || "") || undefined
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("oauth2_token failed");
}

export function summarizeMetadata(meta: JsonMap, extra: JsonMap = {}): JsonMap {
  const isFolder = Boolean(meta.isfolder);
  const out: JsonMap = {
    type: isFolder ? "folder" : "file",
    name: meta.name,
    path: meta.path,
    created: meta.created,
    modified: meta.modified,
    ...extra
  };
  if (isFolder) {
    out.folderid = meta.folderid;
  } else {
    out.fileid = meta.fileid;
    out.size = meta.size;
    out.contenttype = meta.contenttype;
  }
  return out;
}

export function summarizeContents(contents: unknown, limit = 400): {
  items: JsonMap[];
  truncated: boolean;
  total: number;
} {
  const list = Array.isArray(contents) ? (contents as JsonMap[]) : [];
  const items = list.slice(0, limit).map((entry) => summarizeMetadata(entry));
  return { items, truncated: list.length > limit, total: list.length };
}
