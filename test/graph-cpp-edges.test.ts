/**
 * Inferred call edges for C/C++ (issue #68, follow-up to #66).
 *
 * C++ has no import bindings, so edges ride the conservative resolver that
 * already guards every language: same-file match → `extracted`; UNIQUE
 * cross-file match → `inferred`; ambiguous → dropped, never guessed. Member
 * calls resolve only with a receiver type — `this->` (enclosing class, incl.
 * the receiver class of an out-of-class definition body) or a qualified
 * `Class::method(...)` — an untracked `obj.method()` is dropped, not guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { EdgeV1, GraphV1 } from "../src/graph/types.js";

const PHYSICS_H = `#pragma once
class Body {
public:
  void integrate(float dt);
  void applyGravity(float dt);
};

class RigidBody : public Body {
public:
  int mass = 1;
};
`;

const PHYSICS_CPP = `#include "physics.h"

static float clampSpeed(float v) { return v; }

void Body::applyGravity(float dt) { }

void Body::integrate(float dt) {
  this->applyGravity(dt);
  clampSpeed(dt);
  spawnParticles(3);
  helperInit();
  totallyExternal(dt);
}
`;

const WORLD_CPP = `void spawnParticles(int n) { }

void helperInit() { }
`;

const RENDER_CPP = `void helperInit() { }

float Physics_step(float dt) { return dt; }
`;

const ENGINE_CPP = `float Physics::step(float dt) { return dt; }

void frame(float dt) {
  Physics::step(dt);
  gWorld.integrate(dt);
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cpp-edges-"));
  writeFileSync(join(dir, "physics.h"), PHYSICS_H);
  writeFileSync(join(dir, "physics.cpp"), PHYSICS_CPP);
  writeFileSync(join(dir, "world.cpp"), WORLD_CPP);
  writeFileSync(join(dir, "render.cpp"), RENDER_CPP);
  writeFileSync(join(dir, "engine.cpp"), ENGINE_CPP);
  return dir;
}

function edge(graph: GraphV1, source: string, target: string): EdgeV1 | undefined {
  return graph.edges.find((e) => e.source === source && e.target === target && e.relation === "calls");
}

test("C/C++ call edges: unique-name and receiver-typed resolution, ambiguity dropped", async () => {
  const dir = makeFixture();
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");

  const integrate = "physics.cpp#Body.integrate";

  // same-file bare call → extracted
  const clamp = edge(graph!, integrate, "physics.cpp#clampSpeed");
  assert.equal(clamp?.confidence, "extracted", "same-file call should be extracted");

  // unique cross-file bare call → inferred
  const spawn = edge(graph!, integrate, "world.cpp#spawnParticles");
  assert.equal(spawn?.confidence, "inferred", "unique cross-file call should be inferred");

  // this-> member call inside an out-of-class definition → owner-qualified match
  const grav = edge(graph!, integrate, "physics.cpp#Body.applyGravity");
  assert.ok(grav, "this-> call should resolve via the enclosing receiver class");

  // ambiguous name (defined in world.cpp AND render.cpp) → dropped, never guessed
  assert.ok(
    !graph!.edges.some((e) => e.relation === "calls" && e.source === integrate && e.target.includes("helperInit")),
    "ambiguous callee must be dropped",
  );

  // undefined callee → dropped (no dangling name targets for calls)
  assert.ok(
    !graph!.edges.some((e) => e.relation === "calls" && e.target.includes("totallyExternal")),
    "unknown callee must be dropped",
  );

  // qualified Class::method(...) call → owner-qualified match (same file → extracted)
  const step = edge(graph!, "engine.cpp#frame", "engine.cpp#Physics.step");
  assert.equal(step?.confidence, "extracted", "qualified call should resolve via ownerMethod");

  // obj.method() with an UNDECLARED receiver (`gWorld` has no binding in this
  // file — declared receivers resolve via graph-cpp-bindings.test.ts) → dropped
  assert.ok(
    !edge(graph!, "engine.cpp#frame", "physics.cpp#Body.integrate"),
    "member call with unknown receiver type must be dropped",
  );

  // base_class_clause → extends edge (feeds the ancestor walk)
  const ext = graph!.edges.find(
    (e) => e.relation === "extends" && e.source === "physics.h#RigidBody" && e.target === "physics.h#Body",
  );
  assert.ok(ext, "C++ base_class_clause should produce an extends edge");
});
