import * as fs from "node:fs";
import * as path from "node:path";

export interface CompanionSettings {
  workflow?: string;
  dataDir?: string;
  stateDir?: string;
  mcpServerPath?: string;
  mcpServerUrl?: string;
  nodePath?: string;
  allowedRoots?: string[];
  refreshIntervalMs?: number;
  workflowStagesPath?: string;
}

export interface StdioServerConfig {
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  scriptPath: string;
}

export interface HttpServerConfig {
  transport: "http";
  url: string;
  cwd: string;
  authToken?: string;
}

export type ResolvedServerConfig = StdioServerConfig | HttpServerConfig;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Validate a remote `uaw-mcp/v1` Streamable HTTP endpoint URL.
 * Requires `https://` except for loopback hosts, forbids embedded credentials,
 * and rejects non-HTTP(S) schemes and ASCII control characters.
 */
export function validateRemoteUrl(rawUrl: string): string {
  if (typeof rawUrl !== "string" || CONTROL_CHARS_RE.test(rawUrl)) {
    throw new Error("Invalid mcpServerUrl: control characters are not allowed");
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("mcpServerUrl must be non-empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid mcpServerUrl format");
  }
  if (parsed.username || parsed.password) {
    throw new Error("mcpServerUrl must not contain embedded username or password credentials");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`mcpServerUrl must use https:// or http:// (got ${parsed.protocol})`);
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Non-loopback mcpServerUrl "${parsed.hostname}" must use https:// (plaintext http:// is restricted to loopback hosts)`,
    );
  }
  return parsed.toString();
}

/**
 * Derive a SecretStorage key scoped strictly to the validated remote endpoint's origin
 * so a bearer token stored for one host/origin can never be sent to another.
 */
export function secretKeyForRemoteUrl(rawUrl: string): string {
  const validated = validateRemoteUrl(rawUrl);
  const { origin } = new URL(validated);
  return `uwf.mcpAuthToken:${encodeURIComponent(origin)}`;
}

/**
 * Validate `--allowed-roots` entries before joining into a CLI CSV flag.
 */
export function validateAllowedRoots(roots: unknown): string[] {
  if (roots === undefined || roots === null) return [];
  if (!Array.isArray(roots)) {
    throw new Error("allowedRoots must be an array of directory paths");
  }
  const validated: string[] = [];
  for (const entry of roots) {
    if (typeof entry !== "string" || CONTROL_CHARS_RE.test(entry)) {
      throw new Error("Each allowedRoots entry must be a string without control characters");
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error("allowedRoots entries must not be empty");
    }
    if (trimmed.includes(",")) {
      throw new Error(`allowedRoots entry "${trimmed}" must not contain commas`);
    }
    if (trimmed.startsWith("-")) {
      throw new Error(`allowedRoots entry "${trimmed}" must not start with '-'`);
    }
    validated.push(trimmed);
  }
  return validated;
}

function validateSettingPath(rawPath: string, label: string, baseDir: string): string {
  if (CONTROL_CHARS_RE.test(rawPath)) {
    throw new Error(`Invalid ${label}: control characters are not allowed`);
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid ${label}: path must not start with '-'`);
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(baseDir, trimmed);
}

/** Return the staged plugin bundle directory inside `extensionPath`, if present. */
export function resolveBundledPluginRoot(extensionPath: string): string | null {
  const candidate = path.join(extensionPath, "dist", "uaw-plugin");
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    /* ignore unreadable path */
  }
  return null;
}

export function resolveServerConfig(options: {
  extensionPath: string;
  workspaceRoot?: string;
  settings?: CompanionSettings;
  authToken?: string;
  electronRuntime?: boolean;
  allowMonorepoFallback?: boolean;
}): ResolvedServerConfig {
  const {
    extensionPath,
    workspaceRoot,
    settings = {},
    authToken,
    electronRuntime,
    allowMonorepoFallback = false,
  } = options;
  const cwd = workspaceRoot || extensionPath;

  const remoteRaw = settings.mcpServerUrl?.trim();
  if (remoteRaw) {
    return {
      transport: "http",
      url: validateRemoteUrl(remoteRaw),
      cwd,
      authToken: authToken?.trim() || undefined,
    };
  }

  let scriptPath: string | null = null;
  const explicitServer = settings.mcpServerPath?.trim();
  if (explicitServer) {
    const resolved = validateSettingPath(explicitServer, "mcpServerPath", cwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Configured mcpServerPath does not exist: ${resolved}`);
    }
    scriptPath = resolved;
  } else {
    const bundledEntry = path.join(extensionPath, "dist", "uaw-plugin", "runtime", "bin", "uaw-mcp.mjs");
    const monorepoEntry = path.resolve(extensionPath, "..", "bin", "uaw-mcp.mjs");
    if (fs.existsSync(bundledEntry)) {
      scriptPath = bundledEntry;
    } else if (allowMonorepoFallback && fs.existsSync(monorepoEntry)) {
      scriptPath = monorepoEntry;
    }
  }

  if (!scriptPath) {
    throw new Error(
      "Could not locate uaw-mcp.mjs runtime entrypoint. Stage the plugin bundle (npm run stage:bundle) or set uwf.mcpServerPath.",
    );
  }

  const explicitNode = settings.nodePath?.trim();
  let command = process.execPath;
  if (explicitNode) {
    if (CONTROL_CHARS_RE.test(explicitNode) || explicitNode.startsWith("-")) {
      throw new Error("Invalid uwf.nodePath setting");
    }
    command = explicitNode;
  }

  const isElectron =
    electronRuntime ??
    Boolean((process.versions as Record<string, string | undefined>).electron);
  const env: Record<string, string> = {};
  if (!explicitNode && command === process.execPath && isElectron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  const args = [scriptPath, "--transport", "stdio"];
  let allowedRoots = validateAllowedRoots(settings.allowedRoots);
  if (allowedRoots.length === 0) {
    const defaultRoots: string[] = [];
    if (workspaceRoot) {
      defaultRoots.push(path.resolve(workspaceRoot));
    }
    const explicitDataDir = settings.dataDir?.trim();
    if (explicitDataDir) {
      if (!workspaceRoot && !path.isAbsolute(explicitDataDir)) {
        throw new Error(
          "Relative uwf.dataDir requires an open workspace folder when uwf.allowedRoots is empty",
        );
      }
      const resolvedDataDir = validateSettingPath(explicitDataDir, "dataDir", cwd);
      if (!defaultRoots.includes(resolvedDataDir)) {
        defaultRoots.push(resolvedDataDir);
      }
    }
    if (defaultRoots.length === 0) {
      throw new Error(
        "Open a workspace folder or configure uwf.allowedRoots / uwf.dataDir before starting the local UAW MCP runtime.",
      );
    }
    allowedRoots = validateAllowedRoots(defaultRoots);
  }
  args.push("--allowed-roots", allowedRoots.join(","));
  const stateDirRaw = settings.stateDir?.trim();
  if (stateDirRaw) {
    args.push("--state-dir", validateSettingPath(stateDirRaw, "stateDir", cwd));
  }

  return {
    transport: "stdio",
    command,
    args,
    cwd,
    env,
    scriptPath,
  };
}
