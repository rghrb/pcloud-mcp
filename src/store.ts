import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PCloudCreds {
  access_token: string;
  hostname: string;
  uid?: number;
  email?: string;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function loadJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function pcloudCredsPath(dataDir: string): string {
  return join(dataDir, "pcloud.json");
}

export function oauthStorePath(dataDir: string): string {
  return join(dataDir, "oauth.json");
}
