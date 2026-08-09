/**
 * C++ namespace resolution (edge-coverage step 3).
 *
 * Nodes carry their enclosing namespace path (`ns: "game.ai"`), which unlocks
 * two resolutions the flattened view had to drop: a namespace-qualified call
 * (`game::spawn(1)`) resolves to the function whose ns matches the qualifier,
 * and a bare call from inside a namespace prefers the same-namespace candidate
 * when the include closure can't break the tie. Unknown qualifiers still drop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const WORLD_CPP = `namespace game {
void spawn(int n) { }
}
namespace net {
void spawn(int n) { }
}
`;

const AI_CPP = `namespace game {
namespace ai {
void think() { }
}
}
`;

const MAIN_CPP = `void boot() {
  game::spawn(1);
  ai::think();
  other::spawn(1);
}
`;

const GAME_LIB_CPP = `namespace game {
void helper() { }
}
`;

const NET_LIB_CPP = `namespace net {
void helper() { }
}
`;

const GAME_MAIN_CPP = `namespace game {
void run() {
  helper();
}
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cpp-ns-"));
  writeFileSync(join(dir, "world.cpp"), WORLD_CPP);
  writeFileSync(join(dir, "ai.cpp"), AI_CPP);
  writeFileSync(join(dir, "main.cpp"), MAIN_CPP);
  writeFileSync(join(dir, "game_lib.cpp"), GAME_LIB_CPP);
  writeFileSync(join(dir, "net_lib.cpp"), NET_LIB_CPP);
  writeFileSync(join(dir, "game_main.cpp"), GAME_MAIN_CPP);
  return dir;
}

test("C++ namespaces: ns metadata, qualified calls, same-namespace tiebreak", async () => {
  const dir = makeFixture();
  await buildGraph(dir);
  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");

  // nodes carry their namespace path
  const gameSpawn = graph!.nodes.find((n) => n.path === "world.cpp" && n.name === "spawn" && n.ns === "game");
  const netSpawn = graph!.nodes.find((n) => n.path === "world.cpp" && n.name === "spawn" && n.ns === "net");
  const think = graph!.nodes.find((n) => n.name === "think");
  assert.ok(gameSpawn, "game::spawn node should carry ns 'game'");
  assert.ok(netSpawn, "net::spawn node should carry ns 'net'");
  assert.equal(think?.ns, "game.ai", "nested namespaces join with dots");

  const calls = graph!.edges.filter((e) => e.relation === "calls");

  // qualified call resolves by namespace match (innermost qualifier)
  assert.ok(
    calls.some((e) => e.source === "main.cpp#boot" && e.target === gameSpawn!.id && e.confidence === "inferred"),
    "game::spawn(1) should resolve to the ns=game definition",
  );
  assert.ok(
    calls.some((e) => e.source === "main.cpp#boot" && e.target === think!.id),
    "ai::think() should resolve through the nested namespace",
  );
  // unknown qualifier → dropped
  assert.ok(
    !calls.some((e) => e.source === "main.cpp#boot" && e.target === netSpawn!.id),
    "other::spawn(1) must not resolve to any spawn",
  );

  // bare call from inside `namespace game` prefers the same-namespace helper
  assert.ok(
    calls.some((e) => e.source === "game_main.cpp#run" && e.target === "game_lib.cpp#helper" && e.confidence === "inferred"),
    "bare helper() inside namespace game should pick game::helper",
  );
  assert.ok(
    !calls.some((e) => e.target === "net_lib.cpp#helper"),
    "net::helper must never be picked",
  );
});
