/**
 * Rust in the Tier-1 code graph.
 *
 * Definitions: structs, enums, traits (→ interface), type aliases, free
 * functions, and `impl` methods — an inherent `impl Player` and a trait
 * `impl Tickable for Player` both scope their methods under the SELF type
 * (`Player.tick`), which is what a caller writing `p.tick()` means. A
 * `function_signature_item` in a trait is a contract, not a definition.
 * `impl Tickable for Player` also emits an `implements` edge.
 *
 * Calls ride the conservative resolver: bare names (same-file → extracted,
 * repo-unique → inferred), `self.m()` through the enclosing impl type,
 * `Type::assoc()` through the owner-qualified index, and `obj.m()` typed by
 * declared `let x: T` / parameter types. `use` paths resolve through the
 * module ↔ file convention (`crate::world::grid` → src/world/grid.rs or
 * .../grid/mod.rs). Untyped receivers drop — never guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const PLAYER_RS = `use crate::world::grid::Grid;
use crate::util::clamp_speed;

pub struct Player {
    pub hp: f32,
}

pub trait Tickable {
    fn tick(&self);
}

pub enum Biome { Forest, Desert }

pub type Health = f32;

impl Player {
    pub fn new(hp: f32) -> Self { Self { hp } }

    pub fn update(&self, grid: &Grid) {
        self.heal(1.0);
        clamp_speed(2.0);
        grid.cell_at(0);
        let g: Grid = make_grid();
        g.cell_at(1);
        Player::new(3.0);
    }

    fn heal(&self, n: f32) { }
}

impl Tickable for Player {
    fn tick(&self) { }
}

fn make_grid() -> Grid { Grid { } }
`;

const GRID_RS = `pub struct Grid { }

impl Grid {
    pub fn cell_at(&self, i: u32) -> u32 { i }
}
`;

const UTIL_RS = `pub fn clamp_speed(v: f32) -> f32 { v }
`;

const PLAYER = "src/player.rs";
const GRID = "src/world/grid.rs";

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-"));
  mkdirSync(join(dir, "src", "world"), { recursive: true });
  writeFileSync(join(dir, "src", "player.rs"), PLAYER_RS);
  writeFileSync(join(dir, "src", "world", "grid.rs"), GRID_RS);
  writeFileSync(join(dir, "src", "util.rs"), UTIL_RS);
  return dir;
}

test("Rust extraction: items, impls, use paths, receiver-typed calls", async () => {
  const dir = makeFixture();
  const result = await buildGraph(dir);
  assert.ok(result.languages.includes("rust"), `languages should include rust, got [${result.languages}]`);
  assert.deepEqual(result.skipped, []);

  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  const node = (id: string) => graph!.nodes.find((n) => n.id === id);

  // items
  assert.equal(node(`${PLAYER}#Player`)?.kind, "struct");
  assert.equal(node(`${PLAYER}#Tickable`)?.kind, "interface");
  assert.equal(node(`${PLAYER}#Biome`)?.kind, "enum");
  assert.equal(node(`${PLAYER}#Health`)?.kind, "type");
  assert.equal(node(`${PLAYER}#make_grid`)?.kind, "function");
  assert.equal(node(`${PLAYER}#make_grid`)?.exported, false); // no `pub`
  assert.equal(node("src/util.rs#clamp_speed")?.exported, true);
  // a trait's function_signature_item is a contract, not a definition
  assert.ok(
    !graph!.nodes.some((n) => n.id === `${PLAYER}#Tickable.tick`),
    "trait method signatures must not be indexed",
  );

  // impl methods scope under the self type, from both inherent and trait impls
  const update = node(`${PLAYER}#Player.update`);
  assert.equal(update?.kind, "method");
  assert.equal(update?.owner, "Player");
  assert.equal(node(`${PLAYER}#Player.new`)?.owner, "Player");
  assert.equal(node(`${PLAYER}#Player.tick`)?.owner, "Player", "trait impl method scopes under Player");

  // trait impl → implements edge
  assert.ok(
    graph!.edges.some((e) => e.relation === "implements" && e.target === `${PLAYER}#Tickable`),
    "impl Tickable for Player should emit an implements edge",
  );

  // use paths resolve through the module ↔ file convention
  assert.ok(
    graph!.edges.some((e) => e.relation === "imports" && e.source === PLAYER && e.target === GRID),
    "use crate::world::grid::Grid should resolve to the file",
  );

  const calls = graph!.edges.filter((e) => e.relation === "calls");
  const has = (source: string, target: string) => calls.some((e) => e.source === source && e.target === target);
  const from = `${PLAYER}#Player.update`;
  assert.ok(has(from, `${PLAYER}#Player.heal`), "self.heal() resolves through the impl type");
  assert.ok(has(from, "src/util.rs#clamp_speed"), "bare unique cross-file call");
  assert.ok(has(from, `${GRID}#Grid.cell_at`), "receiver typed by parameter and by `let g: Grid`");
  assert.ok(has(from, `${PLAYER}#Player.new`), "Player::new() resolves via the owner-qualified index");
});
