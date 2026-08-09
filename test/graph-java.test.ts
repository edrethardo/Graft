/**
 * Java in the Tier-1 code graph.
 *
 * Definitions: classes, interfaces, enums, records, methods and constructors
 * (bodyless declarations — interface/abstract methods — are contracts, not
 * definitions, and are skipped like every other language's prototypes).
 * Imports resolve by the package-path ↔ directory convention
 * (`com.game.util.Textures` → the unique file ending `com/game/util/
 * Textures.java`). Calls resolve through receiver types like Python/Go:
 * declared locals/params/fields, implicit and explicit `this`, and the
 * Uppercase-receiver convention for static calls (`Textures.load(...)`).
 * `exported` is `public`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const CHUNK_JAVA = `package com.game.world;
import com.game.util.Textures;

public class Chunk extends Region implements Tickable {
  private Mesh mesh;

  public Chunk(int size) {
    rebuild(size);
  }

  public void rebuild(int size) {
    Mesh m = Textures.load(size);
    m.upload();
    mesh.upload();
    this.tick();
  }

  public void tick() { }

  void packagePrivateHelper() { }
}
`;

const REGION_JAVA = `package com.game.world;
public class Region { }
`;

const TICKABLE_JAVA = `package com.game.world;
public interface Tickable {
  void tick();
}
`;

const TEXTURES_JAVA = `package com.game.util;
public class Textures {
  public static Mesh load(int size) { return null; }
}
`;

const MESH_JAVA = `package com.game.gfx;
public class Mesh {
  public void upload() { }
}
`;

const BIOME_JAVA = `package com.game.world;
public enum Biome { FOREST, DESERT }
`;

const VEC2_JAVA = `package com.game.util;
public record Vec2(float x, float y) { }
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-java-"));
  for (const d of ["com/game/world", "com/game/util", "com/game/gfx"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, "com/game/world/Chunk.java"), CHUNK_JAVA);
  writeFileSync(join(dir, "com/game/world/Region.java"), REGION_JAVA);
  writeFileSync(join(dir, "com/game/world/Tickable.java"), TICKABLE_JAVA);
  writeFileSync(join(dir, "com/game/util/Textures.java"), TEXTURES_JAVA);
  writeFileSync(join(dir, "com/game/gfx/Mesh.java"), MESH_JAVA);
  writeFileSync(join(dir, "com/game/world/Biome.java"), BIOME_JAVA);
  writeFileSync(join(dir, "com/game/util/Vec2.java"), VEC2_JAVA);
  return dir;
}

const CHUNK = "com/game/world/Chunk.java";

test("Java extraction: definitions, imports, heritage, receiver-typed calls", async () => {
  const dir = makeFixture();
  const result = await buildGraph(dir);
  assert.ok(result.languages.includes("java"), `languages should include java, got [${result.languages}]`);
  assert.deepEqual(result.skipped, []);

  const graph: GraphV1 | null = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  const node = (id: string) => graph!.nodes.find((n) => n.id === id);

  // definitions
  assert.equal(node(`${CHUNK}#Chunk`)?.kind, "class");
  const rebuild = node(`${CHUNK}#Chunk.rebuild`);
  assert.equal(rebuild?.kind, "method");
  assert.equal(rebuild?.owner, "Chunk");
  assert.equal(rebuild?.exported, true);
  assert.equal(node(`${CHUNK}#Chunk.Chunk`)?.kind, "method"); // constructor
  assert.equal(node(`${CHUNK}#Chunk.packagePrivateHelper`)?.exported, false);
  assert.equal(node("com/game/world/Tickable.java#Tickable")?.kind, "interface");
  assert.equal(node("com/game/world/Biome.java#Biome")?.kind, "enum");
  assert.equal(node("com/game/util/Vec2.java#Vec2")?.kind, "class"); // record
  // a bodyless interface method is a contract, not a definition
  assert.ok(
    !graph!.nodes.some((n) => n.path === "com/game/world/Tickable.java" && n.name === "tick"),
    "interface method declarations must not be indexed",
  );

  // imports resolve via the package-path ↔ directory convention
  assert.ok(
    graph!.edges.some((e) => e.relation === "imports" && e.source === CHUNK && e.target === "com/game/util/Textures.java"),
    "import com.game.util.Textures should resolve to its file",
  );

  // heritage
  assert.ok(
    graph!.edges.some((e) => e.relation === "extends" && e.source === `${CHUNK}#Chunk` && e.target === "com/game/world/Region.java#Region"),
  );
  assert.ok(
    graph!.edges.some((e) => e.relation === "implements" && e.source === `${CHUNK}#Chunk` && e.target === "com/game/world/Tickable.java#Tickable"),
  );

  // calls
  const calls = graph!.edges.filter((e) => e.relation === "calls");
  const has = (source: string, target: string) => calls.some((e) => e.source === source && e.target === target);
  // implicit this: constructor → rebuild, rebuild → tick (same file → extracted)
  assert.ok(has(`${CHUNK}#Chunk.Chunk`, `${CHUNK}#Chunk.rebuild`), "implicit-this call in constructor");
  assert.ok(has(`${CHUNK}#Chunk.rebuild`, `${CHUNK}#Chunk.tick`), "explicit this.tick()");
  // static call via the Uppercase-receiver convention
  assert.ok(has(`${CHUNK}#Chunk.rebuild`, "com/game/util/Textures.java#Textures.load"), "static Textures.load(...)");
  // local `Mesh m` and field `Mesh mesh` both type the receiver
  assert.ok(has(`${CHUNK}#Chunk.rebuild`, "com/game/gfx/Mesh.java#Mesh.upload"), "receiver-typed m.upload()/mesh.upload()");
});
