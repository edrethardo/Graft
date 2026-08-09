/**
 * C++ receiver-type bindings (edge-coverage step 1): `Body body;`, parameter
 * types (`Entity* e`), and same-file class fields bind variable → type, so
 * member calls resolve through the owner-qualified index exactly like
 * Python/Go receivers do — same-file → extracted, cross-file → inferred,
 * ambiguous or untyped → dropped. `auto` binds nothing (no inference).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const BODY_H = `#pragma once
class Body {
public:
  void integrate(float dt) { }
};
`;

const ENTITY_H = `#pragma once
class Entity {
public:
  void update(float dt) { }
};
`;

const GAME_CPP = `#include "body.h"
#include "entity.h"

void frame(Entity* e, float dt) {
  Body body;
  body.integrate(dt);
  e->update(dt);
  auto z = e;
  z.integrate(dt);
}

class Turret {
  Body body;
public:
  void tick(float dt) { body.integrate(dt); }
};
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cpp-bind-"));
  writeFileSync(join(dir, "body.h"), BODY_H);
  writeFileSync(join(dir, "entity.h"), ENTITY_H);
  writeFileSync(join(dir, "game.cpp"), GAME_CPP);
  return dir;
}

test("C++ member calls resolve through declared local, parameter, and field types", async () => {
  const dir = makeFixture();
  await buildGraph(dir);
  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");

  const calls = graph!.edges
    .filter((e) => e.relation === "calls")
    .sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));

  assert.deepEqual(calls, [
    // local declaration `Body body;` types the receiver
    { source: "game.cpp#frame", target: "body.h#Body.integrate", relation: "calls", confidence: "inferred" },
    // parameter `Entity* e` types the receiver
    { source: "game.cpp#frame", target: "entity.h#Entity.update", relation: "calls", confidence: "inferred" },
    // same-file class field `Body body;` types the receiver inside an inline method;
    // `auto z` binds nothing, so `z.integrate(dt)` produces NO edge
    { source: "game.cpp#Turret.tick", target: "body.h#Body.integrate", relation: "calls", confidence: "inferred" },
  ].sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target)));
});
