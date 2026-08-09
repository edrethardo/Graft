/**
 * Swift in the Tier-1 code graph.
 *
 * The grammar spells class/struct/enum/extension all as `class_declaration`,
 * distinguished by their keyword token; protocols are `protocol_declaration`
 * (kind interface), and their bodyless requirements are contracts, not
 * definitions. An `extension Player` indexes as a class node named after the
 * extended type, so its methods carry the right owner. Calls resolve
 * conservatively: bare names via same-file/unique matching (Uppercase bare
 * calls are initializers — skipped), `self.method()` through the enclosing
 * type. Inheritance clauses can't be told apart syntactically (superclass vs
 * protocol), so all emit `extends`, which resolves against classes AND
 * interfaces. `exported` = not private/fileprivate. Swift is inferred-only
 * edge coverage, like C++ and shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const PLAYER_SWIFT = `import Foundation

public class Player: Entity, Tickable {
  private var pos: Vec2

  init(start: Vec2) {
    self.pos = start
  }

  public func tick() {
    self.move(dt: 1)
    clampSpeed(4)
    Vec2(x: 1, y: 2)
  }

  private func move(dt: Float) { }
}
`;

const VEC_SWIFT = `struct Vec2 {
  var x: Float
  var y: Float
}

enum Biome { case forest, desert }
`;

const PROTO_SWIFT = `protocol Tickable {
  func tick()
}
`;

const ENTITY_SWIFT = `public class Entity { }
`;

const UTIL_SWIFT = `func clampSpeed(_ v: Float) -> Float { return v }
`;

const EXT_SWIFT = `extension Player {
  func dash() { }
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-swift-"));
  writeFileSync(join(dir, "player.swift"), PLAYER_SWIFT);
  writeFileSync(join(dir, "vec.swift"), VEC_SWIFT);
  writeFileSync(join(dir, "proto.swift"), PROTO_SWIFT);
  writeFileSync(join(dir, "entity.swift"), ENTITY_SWIFT);
  writeFileSync(join(dir, "util.swift"), UTIL_SWIFT);
  writeFileSync(join(dir, "ext.swift"), EXT_SWIFT);
  return dir;
}

test("Swift extraction: types, protocols, extensions, conservative calls", async () => {
  const dir = makeFixture();
  const result = await buildGraph(dir);
  assert.ok(result.languages.includes("swift"), `languages should include swift, got [${result.languages}]`);
  assert.deepEqual(result.skipped, []);

  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  const node = (id: string) => graph!.nodes.find((n) => n.id === id);

  // class / struct / enum / protocol, told apart by keyword
  assert.equal(node("player.swift#Player")?.kind, "class");
  assert.equal(node("vec.swift#Vec2")?.kind, "struct");
  assert.equal(node("vec.swift#Biome")?.kind, "enum");
  assert.equal(node("proto.swift#Tickable")?.kind, "interface");
  assert.ok(
    !graph!.nodes.some((n) => n.path === "proto.swift" && n.name === "tick"),
    "protocol requirements must not be indexed",
  );

  // methods with owners; visibility → exported; init keeps its name
  const tick = node("player.swift#Player.tick");
  assert.equal(tick?.kind, "method");
  assert.equal(tick?.owner, "Player");
  assert.equal(tick?.exported, true);
  assert.equal(node("player.swift#Player.move")?.exported, false); // private
  assert.equal(node("player.swift#Player.init")?.kind, "method");

  // an extension indexes as the extended type, owning its methods
  assert.equal(node("ext.swift#Player")?.kind, "class");
  assert.equal(node("ext.swift#Player.dash")?.owner, "Player");

  // inheritance clause → extends, resolving to class AND protocol targets
  const heritage = graph!.edges.filter((e) => e.relation === "extends" && e.source === "player.swift#Player");
  assert.deepEqual(heritage.map((e) => e.target).sort(), ["entity.swift#Entity", "proto.swift#Tickable"]);

  // calls: self.move() through the enclosing type; bare unique cross-file;
  // Uppercase bare (initializer) skipped
  const calls = graph!.edges.filter((e) => e.relation === "calls");
  assert.ok(
    calls.some((e) => e.source === "player.swift#Player.tick" && e.target === "player.swift#Player.move" && e.confidence === "extracted"),
    "self.move() should resolve through the enclosing class",
  );
  assert.ok(
    calls.some((e) => e.source === "player.swift#Player.tick" && e.target === "util.swift#clampSpeed" && e.confidence === "inferred"),
    "bare unique cross-file call should be inferred",
  );
  assert.ok(
    !calls.some((e) => e.target.includes("Vec2")),
    "initializer calls must not produce edges",
  );
});
