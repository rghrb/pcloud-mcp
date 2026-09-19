#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { PCloudClient, probeHostname } from "./pcloud.js";
import { createPCloudMcpServer } from "./server.js";
import { loadJson, pcloudCredsPath, type PCloudCreds } from "./store.js";

function wantsStdio(): boolean {
  return process.argv.includes("--stdio") || process.env.TRANSPORT === "stdio";
}

async function resolveClientFromConfig() {
  const config = loadConfig();
  const stored = await loadJson<PCloudCreds | undefined>(
    pcloudCredsPath(config.dataDir),
    undefined
  );
  const token = config.pcloudAccessToken || stored?.access_token;
  if (!token) {
    throw new Error(
      "No pCloud token. Set PCLOUD_ACCESS_TOKEN or run the HTTP server and open /setup."
    );
  }
  const preferred = stored?.hostname || config.pcloudApiHost;
  const probed = await probeHostname(token, preferred);
  return new PCloudClient(token, probed.hostname);
}

async function main(): Promise<void> {
  if (wantsStdio()) {
    const client = await resolveClientFromConfig();
    const config = loadConfig();
    const server = createPCloudMcpServer(async () => client, config.readFileMaxBytes);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const config = loadConfig();
  const app = await createHttpApp(config);
  app.listen(config.port, () => {
    console.log(`pCloud MCP listening on ${config.publicUrl}`);
    console.log(`MCP endpoint: ${config.publicUrl}/mcp`);
    console.log(`Auth mode: ${config.authMode}`);
    if (config.authMode === "oauth") {
      console.log("Connector password is CONNECTOR_PASSWORD or data/connector-password.txt");
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
