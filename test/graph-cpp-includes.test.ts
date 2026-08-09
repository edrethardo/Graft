/**
 * C++ #include capture and include-closure disambiguation (edge-coverage
 * step 2).
 *
 * Quoted includes become `imports` edges: resolved same-dir first, then by
 * unique path-suffix match (headers are found through -I roots, so the
 * literal path is a suffix of the repo path); system includes (<...>) are
 * skipped. The include closure then breaks bare-call ties the repo-global
 * uniqueness gate must refuse: a name defined twice in the repo resolves iff
 * exactly one definition is visible from the calling file — through the
 * closure itself, or through the .h ↔ .cpp stem convention (a definition in
 * solver.cpp is visible where solver.h is included, since prototypes are not
 * indexed as nodes). Ambiguity within the closure still drops.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const ENEMY_CPP = `#include "util/math.h"
#include "phys/solver.h"
#include "missing/gone.h"
#include <cstdio>

void update(float x) {
  clampf(x);
  stepWorld(x);
  dualHelper();
}
`;

// clampf: defined here (in-closure) AND in render/shader.cpp (out of closure)
const MATH_H = `#pragma once
inline float clampf(float v) { return v; }
`;

const SHADER_CPP = `float clampf(float v) { return v * 2; }
`;

// stepWorld: prototype in the included header (not indexed), definition in the
// stem-paired solver.cpp; a second definition lives in other/other.cpp
const SOLVER_H = `#pragma once
void stepWorld(float dt);
`;

const SOLVER_CPP = `void stepWorld(float dt) { }
`;

const OTHER_CPP = `void stepWorld(float dt) { }

void dualHelper() { }
`;

const MORE_CPP = `void dualHelper() { }
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cpp-inc-"));
  for (const d of ["src/game", "src/util", "src/phys", "src/render", "src/other"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, "src/game/enemy.cpp"), ENEMY_CPP);
  writeFileSync(join(dir, "src/util/math.h"), MATH_H);
  writeFileSync(join(dir, "src/render/shader.cpp"), SHADER_CPP);
  writeFileSync(join(dir, "src/phys/solver.h"), SOLVER_H);
  writeFileSync(join(dir, "src/phys/solver.cpp"), SOLVER_CPP);
  writeFileSync(join(dir, "src/other/other.cpp"), OTHER_CPP);
  writeFileSync(join(dir, "src/other/more.cpp"), MORE_CPP);
  return dir;
}

test("C++ includes become imports edges; the closure breaks bare-call ties", async () => {
  const dir = makeFixture();
  await buildGraph(dir);
  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");

  const imports = graph!.edges.filter((e) => e.relation === "imports").map((e) => e.target).sort();
  // suffix-resolved, stem header, unresolved kept as raw spec; <cstdio> absent
  assert.deepEqual(imports, ["missing/gone.h", "src/phys/solver.h", "src/util/math.h"]);

  const calls = graph!.edges
    .filter((e) => e.relation === "calls")
    .sort((a, b) => a.target.localeCompare(b.target));
  assert.deepEqual(calls, [
    // ambiguous repo-wide, unique within the include closure
    { source: "src/game/enemy.cpp#update", target: "src/phys/solver.cpp#stepWorld", relation: "calls", confidence: "inferred" },
    { source: "src/game/enemy.cpp#update", target: "src/util/math.h#clampf", relation: "calls", confidence: "inferred" },
    // dualHelper: two definitions, NEITHER visible from here — still dropped
  ]);
});
