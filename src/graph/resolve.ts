/**
 * Resolve {@link RawEdge} intents into concrete {@link EdgeV1} edges by matching
 * names/specifiers against the whole-repo node index.
 *
 * Confidence mirrors the SCIP/Graphify model:
 *   - `extracted`: the target is certain — a match within the same file, an
 *     import specifier, or a structural containment.
 *   - `inferred`: a bare function target was resolved by a unique name match
 *     across files, which name-shadowing could in principle fool.
 * Ambiguous cross-file matches (a name defined in several files) are dropped
 * rather than guessed. Member calls are stricter: they require a receiver type
 * and owner-qualified method match because a unique bare method name says
 * nothing about the receiver.
 */
import { posix } from "node:path";
import { toPosixPath } from "../util/paths.js";
import { languageOf } from "./extract.js";
import type { EdgeV1, Kind, NodeV1, Relation } from "./types.js";
import type { RawEdge } from "./extract.js";

const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];

/** A Go module discovered in the repo: its `module` path from `go.mod` and the repo
 * directory that `go.mod` lives in (posix, `.` for the repo root). A monorepo may hold
 * several — e.g. `backend/go.mod`, `tools/go.mod`. */
export interface GoModule {
  module: string;
  dir: string;
}

export interface ResolveOptions {
  /** The Go modules found in the repo. Enables mapping Go import package paths
   * (`example.com/app/pkg/util`) to the in-repo directory they name, relative to the
   * owning module's `go.mod` location. Empty/absent → Go imports stay external strings. */
  goModules?: GoModule[];
}

export function resolveEdges(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  opts: ResolveOptions = {},
): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const globalName = new Map<string, NodeV1[]>();
  const perFileName = new Map<string, Map<string, NodeV1[]>>();
  // Owner-qualified method index: "Owner.method" → candidate method nodes, for
  // typed member-call resolution (recvType + name → a specific class's method).
  const ownerMethod = new Map<string, NodeV1[]>();
  // Go package resolution: dir (posix) → its `.go` file node ids, for import mapping.
  const goFilesByDir = new Map<string, string[]>();
  const hasGoModules = !!opts.goModules?.length;
  for (const n of nodes) {
    if (n.kind === "file") {
      if (hasGoModules && n.path.endsWith(".go")) {
        const dir = posix.dirname(toPosixPath(n.path));
        push(goFilesByDir, dir, n.id);
      }
      continue;
    }
    push(globalName, n.name, n);
    let fileMap = perFileName.get(n.path);
    if (!fileMap) perFileName.set(n.path, (fileMap = new Map()));
    push(fileMap, n.name, n);
    if (n.kind === "method" && n.owner) {
      push(ownerMethod, `${n.owner}.${n.name}`, n);
    }
  }

  // classParents: class/interface name → its declared base-class names, from raw
  // `extends` edges (source id's own name → the base name). Used to walk up an
  // inheritance chain when a receiver's own type has no matching method.
  const classParents = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "extends" || !e.name) continue;
    // The declaring class's own bare name — read from its node (keyed by n.name, set
    // once at mint time) rather than re-derived by slicing e.source, which breaks once
    // ids can carry a dedup ordinal (A3's `Cache~2`).
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classParents, ownName, e.name);
  }

  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"]) => {
    const key = `${source}\0${relation}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, target, relation, confidence });
  };

  // C++ visibility (issue #68 step 2): all file ids for suffix-matching include
  // paths, per-file resolved includes, and the .h ↔ .cpp stem pairing that
  // stands in for "the impl of this header" (prototypes are not nodes, so a
  // header's definitions live in its stem-paired implementation file).
  const fileIds = nodes.filter((n) => n.kind === "file").map((n) => n.id);
  const cpp = (path: string): boolean => languageOf(path) === "cpp";
  const cppIncludes = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "imports" || !e.specifier || !cpp(e.file)) continue;
    const target = resolveCppInclude(e.specifier, e.file, fileIds, byId);
    if (byId.has(target)) push(cppIncludes, e.file, target);
  }
  const stemImpls = new Map<string, string[]>();
  for (const id of fileIds) {
    if (!cpp(id) || /\.(h|hpp|hh|hxx)$/i.test(id)) continue;
    push(stemImpls, posix.basename(toPosixPath(id)).replace(/\.[^.]+$/, ""), id);
  }
  const closureCache = new Map<string, Set<string>>();
  const closureOf = (file: string): Set<string> => {
    const cached = closureCache.get(file);
    if (cached) return cached;
    const seenFiles = new Set<string>([file]);
    const frontier = [file];
    while (frontier.length) {
      for (const inc of cppIncludes.get(frontier.pop()!) ?? []) {
        if (!seenFiles.has(inc)) {
          seenFiles.add(inc);
          frontier.push(inc);
        }
      }
    }
    for (const f of [...seenFiles]) {
      for (const impl of stemImpls.get(posix.basename(toPosixPath(f)).replace(/\.[^.]+$/, "")) ?? []) {
        seenFiles.add(impl);
      }
    }
    closureCache.set(file, seenFiles);
    return seenFiles;
  };

  for (const e of rawEdges) {
    if (e.relation === "contains" && e.targetId) {
      add(e.source, e.targetId, "contains", "extracted");
    } else if (e.relation === "imports" && e.specifier) {
      const target =
        hasGoModules && e.file.endsWith(".go")
          ? resolveGoImport(e.specifier, opts.goModules!, goFilesByDir)
          : cpp(e.file)
            ? resolveCppInclude(e.specifier, e.file, fileIds, byId)
            : e.file.endsWith(".java")
              ? resolveJavaImport(e.specifier, fileIds)
              : e.file.endsWith(".rs")
                ? resolveRustUse(e.specifier, fileIds)
                : resolveImport(e.specifier, e.file, byId);
      add(e.source, target, "imports", "extracted");
    } else if (e.relation === "extends" || e.relation === "implements") {
      const kinds: Kind[] = e.relation === "implements" ? ["interface"] : ["class", "interface"];
      const hit = resolveName(e.name!, e.file, kinds, perFileName, globalName);
      // an unresolved base is usually an external/imported type — keep the name.
      add(e.source, hit?.id ?? e.name!, e.relation, hit?.confidence ?? "inferred");
    } else if (e.relation === "references" && e.name && e.specifier) {
      // A named import gives both halves needed for sound resolution: the module
      // it came from and the exported name. Resolve inside that file only, so a
      // same-named symbol elsewhere in the repo cannot become a false edge.
      const targetFile = resolveImport(e.specifier, e.file, byId);
      if (!byId.has(targetFile)) continue; // external or unresolved module
      const candidates = perFileName.get(targetFile)?.get(e.name) ?? [];
      if (candidates.length === 1) add(e.source, candidates[0].id, "references", "extracted");
    } else if (e.relation === "calls") {
      if (e.viaMember) {
        if (!e.recvType) continue;
        const hit = resolveTypedMember(e.recvType, e.name!, e.file, ownerMethod, classParents);
        if (hit === "ambiguous") continue; // drop — never guess past an ambiguous owner
        if (hit) {
          add(e.source, hit.id, "calls", hit.confidence);
          continue;
        }
        // C++ qualified calls arrive as member calls with the qualifier as
        // recvType — but the qualifier may be a NAMESPACE (`game::spawn(1)`),
        // which owns no methods. Resolve against function nodes whose ns path
        // ends in the qualifier; ambiguity still drops (issue #68 step 3).
        if (cpp(e.file)) {
          const inNs = (globalName.get(e.name!) ?? []).filter(
            (n) => n.kind === "function" && n.ns && (n.ns === e.recvType || n.ns.endsWith(`.${e.recvType}`)),
          );
          if (inNs.length === 1) add(e.source, inNs[0].id, "calls", "inferred");
        }
        // Otherwise unresolved. A unique bare method name is not evidence
        // that this receiver has that method.
        continue;
      }
      const hit = resolveName(e.name!, e.file, ["function"], perFileName, globalName);
      if (hit) {
        add(e.source, hit.id, "calls", hit.confidence); // drop unresolved calls (too noisy)
      } else if (cpp(e.file)) {
        // Repo-wide ambiguity the uniqueness gate must refuse can still be
        // honest with more context: exactly one candidate visible in the
        // calling file's include closure, or — failing that — exactly one in
        // the caller's own namespace (an unqualified call inside `namespace
        // game` reaches game::helper without any include). Ambiguity at every
        // level still drops — never guess.
        const candidates = (globalName.get(e.name!) ?? []).filter((n) => n.kind === "function");
        if (candidates.length > 1) {
          const closure = closureOf(e.file);
          const visible = candidates.filter((n) => closure.has(n.path));
          let pick = visible.length === 1 ? visible[0] : null;
          if (!pick) {
            const callerNs = byId.get(e.source)?.ns;
            if (callerNs) {
              const sameNs = candidates.filter((n) => n.ns === callerNs);
              if (sameNs.length === 1) pick = sameNs[0];
            }
          }
          if (pick) add(e.source, pick.id, "calls", "inferred");
        }
      }
    }
  }
  return out;
}

/**
 * Resolve a Java import's dotted path via the package ↔ directory convention:
 * `com.game.util.Textures` names the unique repo file ending
 * `com/game/util/Textures.java`. Wildcard/static imports fail the match and
 * keep their raw text — external, exactly like an unresolved TS specifier.
 */
function resolveJavaImport(spec: string, fileIds: string[]): string {
  const path = `${spec.replace(/\./g, "/")}.java`;
  const suffix = `/${path}`;
  const hits = fileIds.filter((id) => id === path || id.endsWith(suffix));
  return hits.length === 1 ? hits[0] : spec;
}

/**
 * Resolve a Rust `use` path to a repo file via the module ↔ file convention.
 * A path names items, not files, so try progressively shorter prefixes:
 * `crate::world::grid::Grid` → `world/grid/Grid`, then `world/grid` — each as
 * `<p>.rs` or `<p>/mod.rs`, matched as a unique path suffix. Leading
 * `crate`/`self`/`super` are position markers, not directories. Ambiguous or
 * unmatched → the raw spec (external crate), like every other resolver.
 */
function resolveRustUse(spec: string, fileIds: string[]): string {
  const parts = spec.split("::").filter((p) => p && !["crate", "self", "super"].includes(p));
  for (let end = parts.length; end > 0; end--) {
    const base = parts.slice(0, end).join("/");
    for (const cand of [`${base}.rs`, `${base}/mod.rs`]) {
      const hits = fileIds.filter((id) => id === cand || id.endsWith(`/${cand}`));
      if (hits.length === 1) return hits[0];
    }
  }
  return spec;
}

/**
 * Resolve a quoted #include path to a repo file node: same-dir relative first
 * (the compiler's own quote-form rule), then a unique path-suffix match —
 * headers are found through -I roots, so the literal spec is a suffix of the
 * repo-relative path. No match, or an ambiguous suffix → keep the raw spec
 * (external or unresolvable), exactly like the other languages' resolvers.
 */
function resolveCppInclude(
  spec: string,
  file: string,
  fileIds: string[],
  byId: Map<string, NodeV1>,
): string {
  const dir = posix.dirname(toPosixPath(file));
  const rel = posix.normalize(posix.join(dir, spec));
  if (byId.has(rel)) return rel;
  const suffix = `/${spec}`;
  const hits = fileIds.filter((id) => id === spec || id.endsWith(suffix));
  return hits.length === 1 ? hits[0] : spec;
}

function push<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

/**
 * Resolve a bare symbol name: same-file match first (certain → `extracted`),
 * else a unique cross-file match (→ `inferred`), else null (ambiguous/unknown).
 */
function resolveName(
  name: string,
  file: string,
  kinds: Kind[],
  perFileName: Map<string, Map<string, NodeV1[]>>,
  globalName: Map<string, NodeV1[]>,
): { id: string; confidence: EdgeV1["confidence"] } | null {
  const local = (perFileName.get(file)?.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  if (local.length) return { id: local[0].id, confidence: "extracted" };
  const global = (globalName.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  if (global.length === 1) return { id: global[0].id, confidence: "inferred" };
  return null;
}

/**
 * Resolve a typed member call (`recvType.name`) against the owner-qualified method
 * index, walking the receiver's extends chain when its own type has no match.
 *
 * Returns:
 *   - `{ id, confidence }` — resolved: a single candidate at some owner level (or the
 *     same-file one among several).
 *   - `"ambiguous"` — several candidates at some owner level and none is same-file;
 *     per the inviolable philosophy we drop and stop rather than guess, and we do
 *     NOT continue up the chain past this level.
 *   - `null` — the whole chain (recvType + ancestors, breadth-first, depth ≤ 3,
 *     cycle-guarded) had zero candidates at every level.
 */
function resolveTypedMember(
  recvType: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classParents: Map<string, string[]>,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const MAX_DEPTH = 3;
  const visited = new Set<string>([recvType]);
  let frontier = [recvType];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    for (const type of frontier) {
      const candidates = ownerMethod.get(`${type}.${name}`);
      if (!candidates || candidates.length === 0) continue; // try next ancestor
      if (candidates.length === 1) {
        const c = candidates[0];
        return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
      }
      const sameFile = candidates.find((c) => c.path === file);
      if (sameFile) return { id: sameFile.id, confidence: "extracted" };
      return "ambiguous"; // several, none same-file — drop and stop
    }
    const next: string[] = [];
    for (const type of frontier) {
      for (const parent of classParents.get(type) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return null; // chain exhausted, no candidate anywhere
}

/**
 * Resolve a module specifier to a file node id when it points inside the repo;
 * otherwise return the raw specifier (external package or unresolved path).
 */
function resolveImport(spec: string, file: string, byId: Map<string, NodeV1>): string {
  if (!spec.startsWith(".")) return spec;
  // Belt-and-braces: `node.path` is posix by construction (`../util/paths.ts`),
  // but this also accepts a hand-written or hand-edited graph.
  const dir = posix.dirname(toPosixPath(file));
  const base = posix.normalize(posix.join(dir, spec));
  const noExt = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, "");
  const candidates = [
    base,
    ...IMPORT_EXTS.map((e) => noExt + e),
    ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
  ];
  for (const c of candidates) if (byId.has(c)) return c;
  return spec;
}

/**
 * Resolve a Go import package path to an in-repo file node when it points inside one of
 * the repo's modules; otherwise return the raw specifier (stdlib or third-party package).
 *
 * Go imports name a *package* (a directory), not a file. The package path is relative to
 * the owning module's path, so the in-repo directory is `<module go.mod dir>/<subpath>`.
 * This handles a `go.mod` anywhere in the tree — repo root or a subdirectory (monorepo).
 * When several modules' paths prefix the spec, the longest (most specific) wins. A package
 * dir may hold several `.go` files; we pick a deterministic representative (lowest id).
 */
function resolveGoImport(spec: string, modules: GoModule[], filesByDir: Map<string, string[]>): string {
  let best: { mod: GoModule; subpath: string } | null = null;
  for (const mod of modules) {
    let subpath: string | null = null;
    if (spec === mod.module) subpath = "";
    else if (spec.startsWith(mod.module + "/")) subpath = spec.slice(mod.module.length + 1);
    if (subpath === null) continue;
    if (!best || mod.module.length > best.mod.module.length) best = { mod, subpath };
  }
  if (!best) return spec; // stdlib / third-party — keep the package path

  const dir = posix.normalize(posix.join(best.mod.dir, best.subpath));
  const files = filesByDir.get(dir);
  if (!files || files.length === 0) return spec;
  return [...files].sort()[0];
}
