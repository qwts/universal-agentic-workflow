import fs from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function deny(reason, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: additionalContext ?? reason
    }
  };
}

function ask(reason, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
      additionalContext: additionalContext ?? reason
    }
  };
}

function allow(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Allowed by UWF policy",
      additionalContext: additionalContext ?? "Proceed."
    }
  };
}

export function runPreToolUseHook({
  readInput = () => fs.readFileSync(0, "utf8"),
  writeOutput = (s) => process.stdout.write(s),
} = {}) {
  const inputRaw = readInput();
  let input;
  try {
    input = JSON.parse(inputRaw);
  } catch {
    const fallback = {
      continue: true,
      systemMessage:
        "UWF hook warning: could not parse hook JSON input; not enforcing guardrails."
    };
    writeOutput(JSON.stringify(fallback));
    return fallback;
  }

  const toolName = String(input.tool_name ?? "");
  const toolInput = input.tool_input ?? {};
  const toolInputStr = JSON.stringify(toolInput).toLowerCase();

  // 1) Block obviously destructive terminal commands
  if (
    toolName === "runInTerminal" ||
    toolName === "Bash" ||
    toolName.toLowerCase().includes("terminal")
  ) {
    const blocked = [
      "rm -rf",
      "mkfs",
      "dd if=",
      "shutdown",
      "reboot",
      "format ",
      "diskpart",
      "drop table",
      "truncate table",
      "delete from",
      "curl | sh",
      "wget | sh"
    ];
    if (blocked.some((s) => toolInputStr.includes(s))) {
      const decision = deny(
        "Blocked potentially destructive command by UWF policy.",
        "If you truly intend this, run it manually outside agent mode."
      );
      writeOutput(JSON.stringify(decision));
      return decision;
    }
  }

  // 2) Require confirmation for edits in sensitive directories
  if (
    toolName === "editFiles" ||
    toolName === "createFile" ||
    toolName === "createDirectory" ||
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit"
  ) {
    const sensitive = [
      "/.github/",
      "/.vscode/",
      "/infra/prod",
      "/terraform/prod",
      "/k8s/prod"
    ];
    if (sensitive.some((p) => toolInputStr.includes(p))) {
      const decision = ask(
        "Sensitive path change requires explicit confirmation.",
        "Review the diff carefully before allowing changes."
      );
      writeOutput(JSON.stringify(decision));
      return decision;
    }
  }

  // Default: allow
  const decision = allow();
  writeOutput(JSON.stringify(decision));
  return decision;
}

function isDirectCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectCliEntry()) {
  runPreToolUseHook();
}
