#!/usr/bin/env node
/**
 * uaw-mcp — Standalone MCP server entrypoint (uaw-mcp/v1).
 */

const MIN_NODE = [22, 13, 0];

function checkNodeVersion(versionStr = process.versions?.node ?? "0.0.0") {
  const [maj = 0, min = 0, patch = 0] = String(versionStr)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const [reqMaj, reqMin, reqPatch] = MIN_NODE;
  if (maj !== reqMaj) return maj > reqMaj;
  if (min !== reqMin) return min > reqMin;
  return patch >= reqPatch;
}

if (!checkNodeVersion()) {
  process.stderr.write(
    `[uaw-mcp] Node.js >= ${MIN_NODE.join(".")} is required (built-in node:sqlite); found v${process.versions?.node ?? "unknown"}\n`,
  );
  process.exit(2);
}

const { main: mcpMain } = await import("../scripts/uaw-mcp/server.mjs");

mcpMain(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[uaw-mcp] fatal: ${err?.message ?? err}\n`);
  process.exit(2);
});
