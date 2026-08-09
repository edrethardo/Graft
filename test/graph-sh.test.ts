/**
 * Shell (.sh) in the Tier-1 code graph.
 *
 * Definitions: function_definition only (both `foo() {}` and `function foo {}`
 * syntaxes) — shell has no classes or types. Calls are `command` nodes whose
 * name matches a repo-defined function, riding the same conservative resolver
 * as every language: same-file → extracted, unique cross-file → inferred,
 * ambiguous → dropped. External commands (`echo`, `rsync`, …) never resolve —
 * dropped, not dangled. `source` is NOT captured as an import: its path is
 * routinely variable-interpolated ("$LIB/utils.sh"), and a partial capture
 * would read as a complete one. Shell is inferred-only edge coverage, like C++.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const DEPLOY_SH = `#!/usr/bin/env bash
source ./lib.sh

log_info() {
  echo "[info] $1"
}

function deploy_all {
  log_info "deploying"
  make_pkg game
  helper fast
  rsync -a src/ dst/
}

deploy_all
`;

const LIB_SH = `make_pkg() {
  tar -czf "$1.tgz" "$1"
}
`;

const CI_SH = `helper() {
  true
}
`;

const TOOLS_SH = `helper() {
  false
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-sh-"));
  writeFileSync(join(dir, "deploy.sh"), DEPLOY_SH);
  writeFileSync(join(dir, "lib.sh"), LIB_SH);
  writeFileSync(join(dir, "ci.sh"), CI_SH);
  writeFileSync(join(dir, "tools.sh"), TOOLS_SH);
  return dir;
}

test("shell extraction: functions, conservative call edges, no source imports", async () => {
  const dir = makeFixture();
  const result = await buildGraph(dir);
  assert.ok(result.languages.includes("shell"), `languages should include shell, got [${result.languages}]`);
  // an all-shell repo is fully covered — nothing skipped
  assert.deepEqual(result.skipped, []);

  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");

  // both definition syntaxes
  const logInfo = graph!.nodes.find((n) => n.id === "deploy.sh#log_info");
  assert.equal(logInfo?.kind, "function");
  assert.equal(logInfo?.exported, true);
  assert.ok(logInfo?.signature?.includes("log_info"), `signature: ${logInfo?.signature}`);
  assert.equal(graph!.nodes.find((n) => n.id === "deploy.sh#deploy_all")?.kind, "function");
  assert.equal(graph!.nodes.find((n) => n.id === "lib.sh#make_pkg")?.kind, "function");

  // calls: same-file → extracted; unique cross-file → inferred; ambiguous
  // (`helper` in ci.sh AND tools.sh) and external commands → dropped.
  const calls = graph!.edges
    .filter((e) => e.relation === "calls")
    .sort((a, b) => a.target.localeCompare(b.target));
  assert.deepEqual(calls, [
    { source: "deploy.sh#deploy_all", target: "deploy.sh#log_info", relation: "calls", confidence: "extracted" },
    { source: "deploy.sh", target: "deploy.sh#deploy_all", relation: "calls", confidence: "extracted" },
    { source: "deploy.sh#deploy_all", target: "lib.sh#make_pkg", relation: "calls", confidence: "inferred" },
  ].sort((a, b) => a.target.localeCompare(b.target)));

  // `source ./lib.sh` produces no import edge
  assert.ok(
    !graph!.edges.some((e) => e.relation === "imports" || e.relation === "references"),
    "shell must emit no import/reference edges",
  );
});
