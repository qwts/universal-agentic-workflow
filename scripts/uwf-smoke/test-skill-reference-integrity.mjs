/**
 * Smoke test: referenced UWF skills, traits, and persona trait-stage contracts
 * resolve on disk.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-skill-reference-integrity.mjs
 *   node scripts/uwf-smoke/test-skill-reference-integrity.mjs --repo-root <path>
 */

import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPO_ROOT = resolve(__dirname, "../..");
const require = createRequire(
  join(
    SOURCE_REPO_ROOT,
    ".github/skills/uwf-orchestration-engine/package.json",
  ),
);
const yaml = require("js-yaml");

const REFERENCE_SCOPES = [
  ".github/agents",
  ".github/skills",
  ".github/instructions",
  ".github/copilot-instructions.md",
];
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const SKIPPED_FILE_SUFFIXES = [
  ".db",
  ".db-shm",
  ".db-wal",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sqlite",
  ".webp",
  ".woff",
  ".woff2",
];
const SKILL_REFERENCE_PATTERN =
  /\.github\/skills\/(uwf-(?![<{])[A-Za-z0-9_][A-Za-z0-9_-]*)/g;
const TRAIT_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/;

let passed = 0;
let failed = 0;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function repoPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(path) {
  if (!existsSync(path)) return [];
  if (!isDirectory(path)) return [path];

  const files = [];
  const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    compareStrings(left.name, right.name),
  );
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;

    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (
      entry.isFile() &&
      !SKIPPED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseYaml(path) {
  try {
    return { value: yaml.load(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return {
      value: null,
      error: String(error.message ?? error).split("\n", 1)[0],
    };
  }
}

function addTraitReference(findings, traitSources, traitId, source) {
  if (typeof traitId !== "string" || !TRAIT_ID_PATTERN.test(traitId)) {
    findings.push({
      code: "invalid-trait-reference",
      subject: String(traitId),
      detail: `declared by ${source}`,
    });
    return;
  }

  if (!traitSources.has(traitId)) traitSources.set(traitId, new Set());
  traitSources.get(traitId).add(source);
}

function collectSkillFindings(repoRoot) {
  const references = new Map();

  for (const scope of REFERENCE_SCOPES) {
    for (const file of listFiles(join(repoRoot, scope))) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(SKILL_REFERENCE_PATTERN)) {
        const skillName = match[1];
        const line = content.slice(0, match.index).split("\n").length;
        const source = `${repoPath(repoRoot, file)}:${line}`;
        if (!references.has(skillName)) references.set(skillName, new Set());
        references.get(skillName).add(source);
      }
    }
  }

  const findings = [];
  for (const skillName of [...references.keys()].sort(compareStrings)) {
    if (isDirectory(join(repoRoot, ".github/skills", skillName))) continue;

    const sources = [...references.get(skillName)].sort(compareStrings);
    const shownSources = sources.slice(0, 3).join(", ");
    const remainder = sources.length > 3 ? ` (+${sources.length - 3} more)` : "";
    findings.push({
      code: "missing-skill",
      subject: skillName,
      detail: `referenced by ${shownSources}${remainder}`,
    });
  }
  return findings;
}

function collectTraitFindings(repoRoot) {
  const contractsRoot = join(
    repoRoot,
    ".github/skills/uwf-orchestration-engine/stage-contracts",
  );
  const traitsRoot = join(repoRoot, ".github/skills/uwf-traits/traits");
  const findings = [];
  const stageContracts = new Map();
  const traitSources = new Map();
  const personaTraitUses = [];
  const traitDefinitions = new Map();

  if (!isDirectory(contractsRoot)) {
    return [
      {
        code: "missing-stage-contracts",
        subject: repoPath(repoRoot, contractsRoot),
        detail: "stage-contract directory does not exist",
      },
    ];
  }

  const contractFiles = listFiles(contractsRoot).filter(
    (path) => path.endsWith(".yaml") || path.endsWith(".yml"),
  );
  const runtimeContractFiles = new Set(
    readdirSync(contractsRoot)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => join(contractsRoot, name)),
  );
  if (contractFiles.length === 0) {
    findings.push({
      code: "missing-stage-contracts",
      subject: repoPath(repoRoot, contractsRoot),
      detail: "no YAML stage contracts found",
    });
  }

  for (const contractFile of contractFiles) {
    const source = repoPath(repoRoot, contractFile);
    const parsed = parseYaml(contractFile);
    if (parsed.error) {
      findings.push({
        code: "invalid-stage-contract",
        subject: source,
        detail: parsed.error,
      });
      continue;
    }

    if (
      parsed.value == null ||
      typeof parsed.value !== "object" ||
      !Array.isArray(parsed.value.supported_traits)
    ) {
      findings.push({
        code: "invalid-supported-traits",
        subject: source,
        detail: "supported_traits must be an array",
      });
      continue;
    }

    for (const traitId of parsed.value.supported_traits) {
      addTraitReference(findings, traitSources, traitId, source);
    }
    if (runtimeContractFiles.has(contractFile)) {
      stageContracts.set(basename(contractFile, ".yaml"), {
        source,
        supportedTraits: new Set(parsed.value.supported_traits),
      });
    }
  }

  const personaStageFiles = listFiles(join(repoRoot, ".github/skills")).filter(
    (path) =>
      /^\.github\/skills\/uwf-[^/]+\/stages\.ya?ml$/.test(
        repoPath(repoRoot, path),
      ),
  );
  for (const personaStageFile of personaStageFiles) {
    const source = repoPath(repoRoot, personaStageFile);
    const parsed = parseYaml(personaStageFile);
    if (parsed.error) {
      findings.push({
        code: "invalid-persona-stages",
        subject: source,
        detail: parsed.error,
      });
      continue;
    }

    if (
      parsed.value == null ||
      typeof parsed.value !== "object" ||
      !Array.isArray(parsed.value.stages)
    ) {
      findings.push({
        code: "invalid-persona-stages",
        subject: source,
        detail: "stages must be an array",
      });
      continue;
    }

    for (const [index, stage] of parsed.value.stages.entries()) {
      if (stage == null || typeof stage !== "object" || stage.traits === undefined) {
        continue;
      }

      const stageName =
        typeof stage.name === "string" && stage.name.length > 0
          ? stage.name
          : `index ${index}`;
      const stageSource = `${source} stage ${stageName}`;
      if (!Array.isArray(stage.traits)) {
        findings.push({
          code: "invalid-stage-traits",
          subject: stageSource,
          detail: "traits must be an array",
        });
        continue;
      }

      for (const traitId of stage.traits) {
        addTraitReference(findings, traitSources, traitId, stageSource);
        if (
          typeof stage.stage_type === "string" &&
          typeof traitId === "string" &&
          TRAIT_ID_PATTERN.test(traitId)
        ) {
          personaTraitUses.push({
            source: stageSource,
            stageType: stage.stage_type,
            traitId,
          });
        }
      }
    }
  }

  for (const traitId of [...traitSources.keys()].sort(compareStrings)) {
    const traitFile = join(traitsRoot, `${traitId}.yaml`);
    const sources = [...traitSources.get(traitId)].sort(compareStrings).join(", ");
    if (!existsSync(traitFile)) {
      findings.push({
        code: "missing-trait",
        subject: traitId,
        detail: `declared by ${sources}`,
      });
      continue;
    }

    const parsed = parseYaml(traitFile);
    if (parsed.error) {
      findings.push({
        code: "invalid-trait",
        subject: repoPath(repoRoot, traitFile),
        detail: parsed.error,
      });
      continue;
    }

    traitDefinitions.set(traitId, {
      source: repoPath(repoRoot, traitFile),
      value: parsed.value,
    });

    if (
      parsed.value == null ||
      typeof parsed.value !== "object" ||
      parsed.value.trait_id !== traitId
    ) {
      findings.push({
        code: "trait-id-mismatch",
        subject: repoPath(repoRoot, traitFile),
        detail: `expected trait_id ${traitId}, found ${String(parsed.value?.trait_id)}`,
      });
    }
  }

  for (const { source, stageType, traitId } of personaTraitUses) {
    const contract = stageContracts.get(stageType);
    if (!contract || !contract.supportedTraits.has(traitId)) {
      const supported = contract
        ? [...contract.supportedTraits].join(", ")
        : "no stage contract found";
      const contractLocation = contract ? ` in ${contract.source}` : "";
      findings.push({
        code: "unsupported-stage-trait",
        subject: source,
        detail: `trait "${traitId}" is not supported by stage_type "${stageType}"${contractLocation}; supported: ${supported}`,
      });
      continue;
    }

    const traitDefinition = traitDefinitions.get(traitId);
    if (
      traitDefinition?.value != null &&
      typeof traitDefinition.value === "object" &&
      traitDefinition.value.trait_id === traitId &&
      !traitDefinition.value.stage_policies?.[stageType]
    ) {
      findings.push({
        code: "missing-stage-trait-policy",
        subject: source,
        detail:
          `trait "${traitId}" in ${traitDefinition.source} has no ` +
          `stage_policies entry for stage_type "${stageType}"`,
      });
    }
  }

  return findings;
}

function auditRepository(repoRoot) {
  return [...collectSkillFindings(repoRoot), ...collectTraitFindings(repoRoot)].sort(
    (left, right) =>
      compareStrings(
        `${left.code}\0${left.subject}\0${left.detail}`,
        `${right.code}\0${right.subject}\0${right.detail}`,
      ),
  );
}

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function runNegativeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "uwf-reference-integrity-"));
  try {
    const agentsRoot = join(fixtureRoot, ".github/agents");
    const contractsRoot = join(
      fixtureRoot,
      ".github/skills/uwf-orchestration-engine/stage-contracts",
    );
    const personaRoot = join(fixtureRoot, ".github/skills/uwf-fixture");
    const traitsRoot = join(fixtureRoot, ".github/skills/uwf-traits/traits");
    mkdirSync(agentsRoot, { recursive: true });
    mkdirSync(contractsRoot, { recursive: true });
    mkdirSync(personaRoot, { recursive: true });
    mkdirSync(traitsRoot, { recursive: true });

    writeFileSync(
      join(agentsRoot, "fixture.agent.md"),
      "Read `.github/skills/uwf-missing-fixture/SKILL.md`.\n",
    );
    writeFileSync(
      join(contractsRoot, "fixture.yaml"),
      [
        "stage_type: fixture",
        "supported_traits:",
        "  - missing_fixture",
        "  - mismatched_fixture",
        "  - invalid_fixture",
        "  - persona_missing_fixture",
        "  - policyless_fixture",
        "  - valid_fixture",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(contractsRoot, "fixture.yml"),
      "supported_traits:\n  - unsupported_fixture\n",
    );
    mkdirSync(join(contractsRoot, "nested"), { recursive: true });
    writeFileSync(
      join(contractsRoot, "nested/fixture.yaml"),
      "supported_traits:\n  - unsupported_fixture\n",
    );
    writeFileSync(
      join(personaRoot, "stages.yaml"),
      [
        "workflow: fixture",
        "stages:",
        "  - name: fixture",
        "    stage_type: fixture",
        "    traits:",
        "      - persona_missing_fixture",
        "      - unsupported_fixture",
        "      - policyless_fixture",
        "      - valid_fixture",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(traitsRoot, "mismatched_fixture.yaml"),
      "trait_id: different_fixture\n",
    );
    writeFileSync(
      join(traitsRoot, "invalid_fixture.yaml"),
      "trait_id: [unterminated\n",
    );
    writeFileSync(
      join(traitsRoot, "unsupported_fixture.yaml"),
      [
        "trait_id: unsupported_fixture",
        "stage_policies:",
        "  fixture:",
        "    question_policy: standard",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(traitsRoot, "policyless_fixture.yaml"),
      [
        "trait_id: policyless_fixture",
        "stage_policies:",
        "  another_stage:",
        "    question_policy: standard",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(traitsRoot, "valid_fixture.yaml"),
      [
        "trait_id: valid_fixture",
        "stage_policies:",
        "  fixture:",
        "    question_policy: standard",
        "",
      ].join("\n"),
    );

    return auditRepository(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function parseRepoRoot(args) {
  if (args.length === 0) return SOURCE_REPO_ROOT;
  if (args.length === 2 && args[0] === "--repo-root") return resolve(args[1]);
  throw new Error(
    "usage: node scripts/uwf-smoke/test-skill-reference-integrity.mjs [--repo-root <path>]",
  );
}

let targetRoot;
try {
  targetRoot = parseRepoRoot(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log("\nSmoke test: UWF skill-reference and trait integrity\n");

console.log("1. Negative fixtures detect broken references");
const fixtureFindings = runNegativeFixture();
assert(
  "missing skill fixture is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "missing-skill" &&
      finding.subject === "uwf-missing-fixture",
  ),
);
assert(
  "missing trait fixture is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "missing-trait" && finding.subject === "missing_fixture",
  ),
);
assert(
  "persona stages missing trait fixture is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "missing-trait" &&
      finding.subject === "persona_missing_fixture" &&
      finding.detail.includes("stages.yaml"),
  ),
);
assert(
  "mismatched trait_id fixture is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "trait-id-mismatch" &&
      finding.subject.endsWith("mismatched_fixture.yaml"),
  ),
);
assert(
  "invalid trait YAML fixture is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "invalid-trait" &&
      finding.subject.endsWith("invalid_fixture.yaml"),
  ),
);
assert(
  "persona trait unsupported by the direct runtime contract is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "unsupported-stage-trait" &&
      finding.subject.endsWith("stages.yaml stage fixture") &&
      finding.detail.includes('trait "unsupported_fixture"') &&
      finding.detail.includes("stage-contracts/fixture.yaml"),
  ),
);
assert(
  "persona trait without a stage policy is rejected",
  fixtureFindings.some(
    (finding) =>
      finding.code === "missing-stage-trait-policy" &&
      finding.subject.endsWith("stages.yaml stage fixture") &&
      finding.detail.includes('trait "policyless_fixture"') &&
      finding.detail.includes("traits/policyless_fixture.yaml"),
  ),
);
assert(
  "direct runtime contract wins over ignored yml and nested contracts",
  !fixtureFindings.some(
    (finding) =>
      ["unsupported-stage-trait", "missing-stage-trait-policy"].includes(
        finding.code,
      ) && finding.detail.includes('trait "valid_fixture"'),
  ),
);

console.log(`2. Repository references resolve (${targetRoot})`);
if (!isDirectory(targetRoot)) {
  assert("repository root exists", false, targetRoot);
} else {
  const repositoryFindings = auditRepository(targetRoot);
  if (repositoryFindings.length === 0) {
    assert("all referenced skills and persona trait-stage contracts resolve", true);
  } else {
    for (const finding of repositoryFindings) {
      console.error(
        `  ✗ [${finding.code}] ${finding.subject}: ${finding.detail}`,
      );
    }
    failed += repositoryFindings.length;
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
