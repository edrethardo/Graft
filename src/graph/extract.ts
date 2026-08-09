/**
 * Tier-1 extraction: source file → {@link NodeV1}[] + raw edges, via tree-sitter.
 *
 * Deterministic and dependency-only (no LLM, no network). Emits one node per
 * definition (file, class, function, method, interface, type, enum, and TS
 * arrow-function consts) plus unresolved edge intents. Edge *targets* are
 * resolved against the whole-repo node index later, in build.ts.
 */
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Cpp from "tree-sitter-cpp";
import Bash from "tree-sitter-bash";
import Java from "tree-sitter-java";
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import { collectBindings, cppDeclaratorName, goReceiverVarOf, resolveRecvType, type FileBindings } from "./bindings.js";
import type { Kind, NodeV1, Relation } from "./types.js";

export type Language = "typescript" | "tsx" | "python" | "go" | "cpp" | "bash" | "java";

/**
 * How much edge data a language's extraction can honestly claim (issue #66/#68).
 *
 * Every other language resolves cross-file edges through import bindings; C++
 * has none (only #include, namespaces, overloads, templates), so its call
 * edges ride the conservative resolver alone: same-file or unique-name
 * matches, `this->`, and qualified `Class::method(...)` calls — everything
 * else is dropped rather than guessed (see resolve.ts). That yields real but
 * incomplete coverage, so C/C++ is "inferred-only": consumers phrase an empty
 * result as possible undercount, never as "nothing calls this".
 */
export type EdgeCoverage = "full" | "inferred-only";

export function edgeCoverageOf(lang: Language): EdgeCoverage {
  return lang === "cpp" || lang === "bash" ? "inferred-only" : "full";
}

/**
 * Extension → the tree-sitter grammar that parses it, and the label a human expects
 * to see for it.
 *
 * The two are not the same, and conflating them under-reported coverage: `.mjs` is
 * parsed by the typescript grammar, so a JS repo's build banner read `[typescript]`
 * and a `.jsx` one read `[tsx]`. Both are true about the *parser* and misleading
 * about the repo — people went looking for why their JavaScript hadn't been indexed
 * when it had, and could not tell a language that was merely unlabelled from one
 * that really was skipped (see issue #36).
 *
 * One table, both readings derived from it, so adding an extension cannot fix
 * extraction and forget the label. Ordered longest-suffix-first: `.tsx` has to be
 * tested before `.ts` would match it.
 */
const EXTENSIONS: ReadonlyArray<{ ext: string; grammar: Language; label: string }> = [
  { ext: ".tsx", grammar: "tsx", label: "tsx" },
  { ext: ".jsx", grammar: "tsx", label: "jsx" },
  { ext: ".mts", grammar: "typescript", label: "typescript" },
  { ext: ".cts", grammar: "typescript", label: "typescript" },
  { ext: ".ts", grammar: "typescript", label: "typescript" },
  { ext: ".mjs", grammar: "typescript", label: "javascript" },
  { ext: ".cjs", grammar: "typescript", label: "javascript" },
  { ext: ".js", grammar: "typescript", label: "javascript" },
  { ext: ".pyi", grammar: "python", label: "python" },
  { ext: ".py", grammar: "python", label: "python" },
  { ext: ".go", grammar: "go", label: "go" },
  // One grammar and one label for the whole C family: the cpp grammar parses C,
  // and `.h` can't be attributed to either language from its name alone, so a
  // split label would misreport every C repo's headers (or every C++ one's).
  { ext: ".cpp", grammar: "cpp", label: "c/c++" },
  { ext: ".cxx", grammar: "cpp", label: "c/c++" },
  { ext: ".cc", grammar: "cpp", label: "c/c++" },
  { ext: ".hpp", grammar: "cpp", label: "c/c++" },
  { ext: ".hxx", grammar: "cpp", label: "c/c++" },
  { ext: ".hh", grammar: "cpp", label: "c/c++" },
  { ext: ".c", grammar: "cpp", label: "c/c++" },
  { ext: ".h", grammar: "cpp", label: "c/c++" },
  { ext: ".bash", grammar: "bash", label: "shell" },
  { ext: ".sh", grammar: "bash", label: "shell" },
  { ext: ".java", grammar: "java", label: "java" },
];

function entryFor(path: string): (typeof EXTENSIONS)[number] | undefined {
  const p = path.toLowerCase();
  return EXTENSIONS.find((e) => p.endsWith(e.ext));
}

/** Map a file path to a supported language, or null if unsupported. */
export function languageOf(path: string): Language | null {
  return entryFor(path)?.grammar ?? null;
}

/**
 * What to *call* the language of this file, for a banner or a repo map — or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 */
export function languageLabelOf(path: string): string | null {
  return entryFor(path)?.label ?? null;
}

/**
 * An edge whose target isn't resolved yet. build.ts turns these into EdgeV1 by
 * matching `name`/`specifier` against the repo-wide node index.
 */
export interface RawEdge {
  source: string; // resolved node id
  relation: Relation;
  file: string; // the file this edge originates in (scopes name resolution)
  targetId?: string; // already-resolved target (contains)
  specifier?: string; // module path to resolve (imports / imported-symbol references)
  name?: string; // symbol name to resolve (extends/implements/calls)
  viaMember?: boolean; // calls: was it `obj.foo()` (→ prefer method targets)?
  /** calls with viaMember: the receiver's resolved type name (from bindings /
   * self / this / Go receiver), when a confident local clue exists. */
  recvType?: string;
}

export interface ExtractResult {
  nodes: NodeV1[];
  rawEdges: RawEdge[];
}

/** Max chars of normalized body stored per symbol for search. Large enough that
 * essentially every real definition is stored whole — only a rare giant function
 * is clipped — while bounding how much the committed graph can grow. */
const MAX_BODY_CHARS = 5000;

/** Cap for a file node's module-level residual (imports, constants, module
 * docstring — everything not inside a symbol). Higher than the per-symbol cap
 * because a data-heavy module (constant tables, big config dicts) is legitimate
 * residual, and it's the recall play — but still bounded. */
const MAX_FILE_BODY_CHARS = 16000;

/** The searchable body of a definition: its source text, whitespace-collapsed
 * so every identifier becomes a token, capped at `max`. Search-only — the agent
 * still reads verbatim source via `ask --source`, which slices the file from
 * disk, so nothing here reaches the agent's context. */
function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

/** A file's module-level residual: the lines NOT covered by any symbol span.
 * Symbol bodies are already indexed on their own nodes, so this captures only
 * what they miss — top-of-file imports, module constants, module docstrings —
 * making a file findable by a term that lives outside every function/class.
 * `symbols` are the file's emitted nodes (with `Lx-Ly` spans); `source` is the
 * whole file. Far leaner than storing full-file bodies (no symbol duplication). */
function fileResidual(source: string, symbols: NodeV1[]): string {
  const lines = source.split("\n");
  const covered = new Uint8Array(lines.length + 2);
  for (const s of symbols) {
    const m = s.span.match(/^L(\d+)-L(\d+)$/);
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]) && r < covered.length; r++) covered[r] = 1;
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) if (!covered[i + 1]) kept.push(lines[i]);
  return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}

const TS_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const PY_KINDS: Record<string, Kind> = {
  class_definition: "class",
  function_definition: "function", // → "method" inside a class (resolved in the walk)
};

// Go: `type_spec` is intentionally absent — its kind (struct/interface/type) depends on
// the named type's shape, so it's resolved dynamically in describe().
const GO_KINDS: Record<string, Kind> = {
  function_declaration: "function",
  method_declaration: "method",
};

// C/C++: empty on purpose — every definition shape depends on its declarator
// (or on having a body at all), so describeCpp() resolves them dynamically.
const CPP_KINDS: Record<string, Kind> = {};

// Java: every mapped shape carries a `name` field, so the generic describe()
// path handles them; records are classes with value semantics. Bodyless
// method declarations (interface/abstract contracts) are skipped in describe().
const JAVA_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  record_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  method_declaration: "method",
  constructor_declaration: "method",
};

// Shell: functions are the only definition shape (`foo() {}` and
// `function foo {}` both parse as function_definition with a name field).
const BASH_KINDS: Record<string, Kind> = {
  function_definition: "function",
};

const KINDS_BY_LANG: Record<Language, Record<string, Kind>> = {
  typescript: TS_KINDS,
  tsx: TS_KINDS,
  python: PY_KINDS,
  go: GO_KINDS,
  cpp: CPP_KINDS,
  bash: BASH_KINDS,
  java: JAVA_KINDS,
};

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

const parser = new Parser();
const GRAMMARS: Record<Language, unknown> = {
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  go: Go,
  cpp: Cpp,
  bash: Bash,
  java: Java,
};

export interface WalkCtx {
  rel: string;
  source: string;
  lang: Language;
  kinds: Record<string, Kind>;
  scope: string[]; // enclosing definition names, for id scoping
  enclosingKind: Kind | null; // kind of the nearest enclosing definition
  parentId: string; // nearest enclosing definition id, or the file id
  bindings: FileBindings; // variable/field -> type, for receiver-type lookups
  enclosingClass: string | null; // nearest enclosing class (py/ts `self`/`this`)
  goReceiverVar: string | null; // Go receiver var, e.g. `w` in `func (w *Worker)`
  importedSymbols: ReadonlyMap<string, { name: string; specifier: string }>;
  cppNamespace: string[]; // C++ only: enclosing namespace path, [] elsewhere
}

/** A definition we're about to emit, normalized across the shapes we handle. */
interface DefDescriptor {
  name: string; // the bare symbol name (used for the node's `name` and call resolution)
  idName?: string; // id-scope segment when it differs from `name` (Go: `Receiver.method`)
  kind: Kind;
  headerEnd: number; // char index where the signature ends (body starts)
  hashNode: Parser.SyntaxNode; // node whose text forms body_hash / span
  /** methods whose owner isn't the enclosing walk context: a C++ out-of-class
   * definition (`Physics::step`) names its class in the declarator, not in any
   * ancestor node. */
  owner?: string;
}

/** tree-sitter's string `parse()` fails with "Invalid argument" on any input
 * ≥ 32 KB, which silently drops large files — often the most important ones (a
 * 2000-line command module, a core tab implementation). The callback form has
 * no such limit as long as each returned chunk is under 32 KB, so we always feed
 * the source in <32 KB slices. Code-unit indexing matches `String.slice`. */
const PARSE_CHUNK = 16384;
function parseSource(source: string): Parser.SyntaxNode {
  return parser.parse((index: number) => source.slice(index, index + PARSE_CHUNK)).rootNode;
}

export function extractFile(rel: string, source: string, lang: Language): ExtractResult {
  parser.setLanguage(GRAMMARS[lang] as never);
  const root = parseSource(source);
  const bindings = collectBindings(root, lang);
  const importedSymbols = collectImportedSymbols(root, lang);

  const nodes: NodeV1[] = [
    {
      id: rel,
      name: basename(rel),
      kind: "file",
      path: rel,
      span: `L1-L${root.endPosition.row + 1}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    },
  ];
  const rawEdges: RawEdge[] = [];

  const ctx: WalkCtx = {
    rel,
    source,
    lang,
    kinds: KINDS_BY_LANG[lang],
    scope: [],
    enclosingKind: null,
    parentId: rel,
    bindings,
    enclosingClass: null,
    goReceiverVar: null,
    importedSymbols,
    cppNamespace: [],
  };
  // Every id minted this file, seeded with the file node's own id (`rel`) so a
  // top-level definition can never collide with it. Threaded as its own
  // parameter rather than living on WalkCtx — WalkCtx is spread into every
  // childCtx, so a by-ref Set there would read as ordinary inherited context
  // when it's actually accidental shared mutable state across the whole walk.
  const minted = new Set<string>([rel]);
  for (const child of root.namedChildren) walk(child, ctx, nodes, rawEdges, minted);
  // nodes[0] is the file node; the rest are its symbols. Index the module-level
  // residual on the file node so a term outside every symbol still surfaces it.
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Mint-time uniqueness: a document-order duplicate (same name reopened, or two
 * sibling defs that happen to collide) gets `~2`, `~3`, ... instead of silently
 * shadowing the first. The while-loop (not a single `~2` guess) is what makes
 * this collision-proof: a source name that itself ends in ~N would collide
 * with a single-guess suffix, so this keeps incrementing until it finds a
 * truly free id rather than trusting one candidate suffix is unused. */
export function mintId(base: string, minted: Set<string>): string {
  let id = base;
  let k = 2;
  while (minted.has(id)) id = `${base}~${k++}`;
  minted.add(id);
  return id;
}

function walk(node: Parser.SyntaxNode, ctx: WalkCtx, out: NodeV1[], edges: RawEdge[], minted: Set<string>): void {
  const desc = describe(node, ctx);
  if (desc) {
    // `idName` scopes the id (e.g. a Go method under its receiver: `#DB.Count`) while
    // `name` stays the bare symbol name so member-call resolution matches it.
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    // The bare name of this node's OWN immediate enclosing class/receiver — for a
    // Go method that's its receiver type (methods aren't nested, so ctx.enclosingClass
    // wouldn't see it); for every other method it's simply what the nearest ancestor
    // class already set as ctx.enclosingClass. Only method nodes carry it — resolve.ts's
    // ownerMethod index is the sole consumer (see NodeV1.owner's doc comment).
    const owner: string | undefined =
      desc.kind === "method"
        ? (desc.owner ?? (isGoMethod ? (goReceiverType(node) ?? undefined) : (ctx.enclosingClass ?? undefined)))
        : undefined;
    out.push({
      id,
      name: desc.name,
      kind: desc.kind,
      path: ctx.rel,
      span: `L${desc.hashNode.startPosition.row + 1}-L${desc.hashNode.endPosition.row + 1}`,
      signature: clean(ctx.source.slice(desc.hashNode.startIndex, desc.headerEnd)),
      exported:
        ctx.lang === "python"
          ? !desc.name.startsWith("_")
          : ctx.lang === "go"
            ? goExported(desc.name)
            : ctx.lang === "cpp" || ctx.lang === "bash"
              ? true // no module/visibility system at Tier-1
              : ctx.lang === "java"
                ? javaExported(node)
                : tsExported(node),
      origin: "ast",
      body_hash: contentHash(desc.hashNode.text),
      body_text: searchBody(desc.hashNode.text),
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(owner !== undefined ? { owner } : {}),
      ...(ctx.cppNamespace.length > 0 ? { ns: ctx.cppNamespace.join(".") } : {}),
    });
    // structural containment
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    // class heritage (C++ structs inherit too — default-public class)
    if (desc.kind === "class" || (ctx.lang === "cpp" && desc.kind === "struct"))
      edges.push(...heritageEdges(node, id, ctx));

    // structs count: a C++ struct is a class with default-public members, and its
    // inline methods need an owner just like a class's. (Go structs never contain
    // definitions, so including "struct" here is a no-op for them.) `desc.owner`
    // (only ever set for C++ out-of-class definitions) makes `this->x()` inside
    // `void Physics::step() { ... }` resolve against Physics — the receiver class
    // is named in the declarator, not in any enclosing node.
    const enclosingClass =
      desc.kind === "class" || desc.kind === "struct"
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : (desc.owner ?? ctx.enclosingClass);
    const childCtx: WalkCtx = {
      ...ctx,
      scope: [...ctx.scope, idPart],
      enclosingKind: desc.kind,
      parentId: id,
      enclosingClass,
      goReceiverVar: isGoMethod ? goReceiverVarOf(node) : ctx.goReceiverVar,
      importedSymbols:
        desc.kind === "function" || desc.kind === "method"
          ? withoutShadowedImports(ctx.importedSymbols, node)
          : ctx.importedSymbols,
    };
    for (const child of node.namedChildren) walk(child, childCtx, out, edges, minted);
    return;
  }

  // C++ namespaces don't emit nodes (members keep bare names — see issue #66),
  // but membership is tracked so nodes can carry their `ns` path.
  if (ctx.lang === "cpp" && node.type === "namespace_definition") {
    const nsName = node.childForFieldName("name")?.text;
    const nsCtx = nsName ? { ...ctx, cppNamespace: [...ctx.cppNamespace, nsName] } : ctx;
    for (const child of node.namedChildren) walk(child, nsCtx, out, edges, minted);
    return;
  }

  // not a definition — capture calls/imports/references, then descend with the same context
  const callType =
    ctx.lang === "python" ? "call" : ctx.lang === "bash" ? "command" : ctx.lang === "java" ? "method_invocation" : "call_expression";
  if (node.type === callType) {
    const callee = calleeName(node, ctx.lang);
    if (callee) {
      const callEdge: RawEdge = {
        source: ctx.parentId,
        relation: "calls",
        name: callee.name,
        viaMember: callee.viaMember,
        file: ctx.rel,
      };
      // A qualified C++ call (`Physics::step(...)`) names its receiver TYPE in
      // the callee itself — no bindings lookup can or should improve on it.
      const recvType = callee.recvType ?? resolveRecvType(callee.receiver, ctx);
      edges.push(recvType ? { ...callEdge, recvType } : callEdge);
    }
  } else if (isImport(node, ctx.lang)) {
    const spec = importSpecifier(node, ctx.lang);
    if (spec) edges.push({ source: ctx.rel, relation: "imports", specifier: spec, file: ctx.rel });
    // Imported identifiers are declarations, not uses. The import-binding pass
    // above already recorded them, so do not descend and emit false references.
    return;
  } else if (
    node.type === "identifier" &&
    !isDirectCallee(node, callType) &&
    !isDeclarationName(node)
  ) {
    const imported = ctx.importedSymbols.get(node.text);
    if (imported) {
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: imported.name,
        specifier: imported.specifier,
        file: ctx.rel,
      });
    }
  }

  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}

/**
 * Named imports whose local binding can be recognized later as a symbol use.
 * Namespace/default imports are intentionally excluded: they do not tell us
 * the exported symbol name, so wiring them would require guessing.
 */
function collectImportedSymbols(
  root: Parser.SyntaxNode,
  lang: Language,
): Map<string, { name: string; specifier: string }> {
  const out = new Map<string, { name: string; specifier: string }>();
  if (lang !== "typescript" && lang !== "tsx") return out;

  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "import_statement") {
      const specifier = importSpecifier(node, lang);
      if (!specifier) return;
      collectTsImportBindings(node, specifier, out);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function collectTsImportBindings(
  node: Parser.SyntaxNode,
  specifier: string,
  out: Map<string, { name: string; specifier: string }>,
): void {
  if (node.type === "import_specifier") {
    const name = node.childForFieldName("name")?.text;
    const local = node.childForFieldName("alias")?.text ?? name;
    if (name && local) out.set(local, { name, specifier });
    return;
  }
  for (const child of node.namedChildren) collectTsImportBindings(child, specifier, out);
}

/**
 * A parameter or local declaration wins over an import inside that function.
 * Drop that imported binding for the whole function rather than create a false
 * dependency. Nested functions are separate scopes and filter themselves.
 */
function withoutShadowedImports(
  imports: ReadonlyMap<string, { name: string; specifier: string }>,
  definition: Parser.SyntaxNode,
): ReadonlyMap<string, { name: string; specifier: string }> {
  if (imports.size === 0) return imports;
  const shadowed = new Set<string>();
  const definitionValue = definition.childForFieldName("value");
  const visit = (node: Parser.SyntaxNode): void => {
    if (node !== definition && node !== definitionValue && isFunctionBoundary(node)) {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
      return;
    }
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
    } else if (node.type === "required_parameter" || node.type === "optional_parameter") {
      const pattern = node.childForFieldName("pattern");
      if (pattern?.type === "identifier") shadowed.add(pattern.text);
    } else if (node.type === "identifier" && node.parent?.type === "formal_parameters") {
      shadowed.add(node.text);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(definition);
  if (![...shadowed].some((name) => imports.has(name))) return imports;
  return new Map([...imports].filter(([local]) => !shadowed.has(local)));
}

function isFunctionBoundary(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "method_definition" ||
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function"
  );
}

/** A direct invocation already emits a stronger `calls` edge. */
function isDirectCallee(node: Parser.SyntaxNode, callType: string): boolean {
  const parent = node.parent;
  return parent?.type === callType && parent.childForFieldName("function") === node;
}

/** Definition/declaration identifiers name a new binding; they do not use one. */
function isDeclarationName(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  return parent?.childForFieldName("name") === node;
}

/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (ctx.lang === "go") return describeGo(node, ctx);
  if (ctx.lang === "cpp") return describeCpp(node, ctx);
  // Java: a bodyless method_declaration (interface/abstract) is a contract,
  // not a definition — indexing it would shadow the one real implementation.
  if (ctx.lang === "java" && node.type === "method_declaration" && !node.childForFieldName("body")) {
    return null;
  }

  const mapped = ctx.kinds[node.type];
  if (mapped) {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    let kind = mapped;
    if (ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") {
      kind = "method";
    }
    const body = node.childForFieldName("body");
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  // TS: `const foo = (…) => …` / `const foo = function () {}`
  if ((ctx.lang === "typescript" || ctx.lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FUNCTION_VALUE_TYPES.has(value.type)) {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const vbody = value.childForFieldName("body");
      return {
        name,
        kind: "function",
        headerEnd: vbody ? vbody.startIndex : node.endIndex,
        hashNode: node,
      };
    }
  }
  return null;
}

/** Go definition shapes: top-level funcs, receiver methods, and named types
 * (struct / interface / type alias). Methods carry no nesting — they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node: Parser.SyntaxNode, _ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "function_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const body = node.childForFieldName("body");
    return { name, kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "method_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const recv = goReceiverType(node);
    const body = node.childForFieldName("body");
    // Bare `name` (so `recv.Method()` calls resolve); receiver-qualified `idName`
    // (so the id is `file.go#Receiver.Method` and stays unique per receiver).
    return {
      name,
      idName: recv ? `${recv}.${name}` : name,
      kind: "method",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // `type Name <shape>` — one type_spec per name (grouped `type ( … )` yields several).
  if (node.type === "type_spec") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const type = node.childForFieldName("type");
    const kind: Kind =
      type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type";
    // Header ends where the body opens (`{`) for struct/interface, else the whole node
    // (a one-line alias like `type ID int`).
    const headerEnd = type && (kind === "struct" || kind === "interface") ? type.startIndex : node.endIndex;
    return { name, kind, headerEnd, hashNode: node };
  }

  return null;
}

/** C/C++ definition shapes (issue #66, definitions-only): function definitions
 * (free, inline-in-class, and out-of-class `Type::method`), plus named
 * class/struct/enum bodies. Declarations without a body — prototypes, forward
 * declarations, extern declarations — are intentionally NOT definitions: a
 * header's `void update(float);` would otherwise shadow the one real
 * definition under the same name in every skeleton/grep result.
 *
 * `namespace_definition` and `template_declaration` need no case of their own:
 * describe() returning null makes the walk descend, so the definitions inside
 * are found with their own spans (a template symbol's span excludes the
 * `template<…>` header — a bounded imprecision, traded for never emitting the
 * same definition twice). */
function describeCpp(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "function_definition") {
    const named = cppDeclaratorName(node.childForFieldName("declarator"));
    if (!named) return null;
    const body = node.childForFieldName("body");
    const headerEnd = body ? body.startIndex : node.endIndex;
    // A qualifier (`Physics::step`) or an enclosing class/struct body makes it a
    // method; the qualifier also names the owner the walk context can't see.
    if (named.qualifier) {
      return {
        name: named.name,
        idName: `${named.qualifier}.${named.name}`,
        kind: "method",
        owner: named.qualifier,
        headerEnd,
        hashNode: node,
      };
    }
    const inType = ctx.enclosingKind === "class" || ctx.enclosingKind === "struct";
    return { name: named.name, kind: inType ? "method" : "function", headerEnd, hashNode: node };
  }

  const kind: Kind | null =
    node.type === "class_specifier"
      ? "class"
      : node.type === "struct_specifier"
        ? "struct"
        : node.type === "enum_specifier"
          ? "enum"
          : null;
  if (kind) {
    // Both name AND body required: `class Physics;` (forward declaration) and an
    // anonymous `struct { … }` are not definitions we can index.
    const name = node.childForFieldName("name")?.text;
    const body = node.childForFieldName("body");
    if (!name || !body) return null;
    return { name, kind, headerEnd: body.startIndex, hashNode: node };
  }

  return null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (u *User) …` → `User`). Null if it can't be read. */
function goReceiverType(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver"); // parameter_list
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Go visibility: a symbol is exported iff its own name starts with an uppercase
 * letter. For a receiver-qualified method name, the own name is the part after the dot. */
function goExported(name: string): boolean {
  const own = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const first = own[0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

function heritageEdges(node: Parser.SyntaxNode, classId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  if (ctx.lang === "java") {
    const sup = node.namedChildren.find((c) => c.type === "superclass");
    for (const t of sup?.namedChildren ?? []) {
      if (t.type === "type_identifier") edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    const ifaces = node.namedChildren.find((c) => c.type === "super_interfaces");
    const list = ifaces?.namedChildren.find((c) => c.type === "type_list");
    for (const t of list?.namedChildren ?? []) {
      if (t.type === "type_identifier") edges.push({ source: classId, relation: "implements", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "cpp") {
    // `class RigidBody : public Body { ... }` — base_class_clause children are
    // the base type names (access specifiers are unnamed siblings).
    const clause = node.namedChildren.find((c) => c.type === "base_class_clause");
    for (const t of clause?.namedChildren ?? []) {
      if (t.type === "type_identifier") {
        edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "python") {
    const supers = node.childForFieldName("superclasses"); // argument_list
    for (const c of supers?.namedChildren ?? []) {
      if (c.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: c.text, file: ctx.rel });
      }
    }
    return edges;
  }
  const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
  for (const clause of heritage?.namedChildren ?? []) {
    const relation: Relation | null =
      clause.type === "implements_clause"
        ? "implements"
        : clause.type === "extends_clause"
          ? "extends"
          : null;
    if (!relation) continue;
    for (const t of clause.namedChildren) {
      if (t.type === "identifier" || t.type === "type_identifier") {
        edges.push({ source: classId, relation, name: t.text, file: ctx.rel });
      }
    }
  }
  return edges;
}

function calleeName(
  node: Parser.SyntaxNode,
  lang: Language,
): { name: string; viaMember: boolean; receiver?: string; recvType?: string } | null {
  // Java: method_invocation carries `name` + optional `object`. No object or
  // `this` → the enclosing class's own method. An Uppercase identifier
  // receiver is a class name by Java convention → a static call, typed by the
  // receiver text itself. `this.field.m()` defers to the field's binding.
  if (lang === "java") {
    const nameN = node.childForFieldName("name");
    if (!nameN) return null;
    const name = nameN.text;
    const obj = node.childForFieldName("object");
    if (!obj || obj.type === "this") return { name, viaMember: true, receiver: "this" };
    if (obj.type === "identifier") {
      const first = obj.text[0] ?? "";
      if (first !== first.toLowerCase() && first === first.toUpperCase()) {
        return { name, viaMember: true, recvType: obj.text };
      }
      return { name, viaMember: true, receiver: obj.text };
    }
    if (obj.type === "field_access") {
      const fobj = obj.childForFieldName("object");
      const ffield = obj.childForFieldName("field");
      if (fobj?.type === "this" && ffield) return { name, viaMember: true, receiver: `this.${ffield.text}` };
    }
    return { name, viaMember: true }; // untyped receiver — dropped at resolve
  }
  // Shell: a `command` node's callee is its `name` field. Only a name that
  // matches a repo-defined function will resolve — external binaries and
  // builtins drop out at resolution. `source`/`.` is sourcing, not a call
  // (and deliberately not an import either: the path is routinely
  // variable-interpolated, and a partial capture would read as a complete one).
  if (lang === "bash") {
    const name = node.childForFieldName("name");
    if (name?.type !== "command_name") return null;
    if (name.text === "source" || name.text === ".") return null;
    return { name: name.text, viaMember: false };
  }
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, viaMember: false };
  if (lang === "cpp") {
    // `obj.method()` / `ptr->tick()` / `this->applyGravity()` — the receiver
    // TEXT only; resolveRecvType maps `this` to the enclosing class and drops
    // everything else (no bindings for C++), so untracked receivers are
    // captured-then-dropped, never guessed.
    if (fn.type === "field_expression") {
      const field = fn.childForFieldName("field");
      const arg = fn.childForFieldName("argument");
      const receiver = arg?.type === "this" ? "this" : arg?.type === "identifier" ? arg.text : undefined;
      return field ? { name: field.text, viaMember: true, receiver } : null;
    }
    // `Physics::step(...)` — the qualifier IS the receiver type; innermost scope
    // wins on a nested chain (`game::Physics::step` → Physics).
    if (fn.type === "qualified_identifier") {
      let recvType: string | undefined;
      let n: Parser.SyntaxNode | null = fn;
      while (n?.type === "qualified_identifier") {
        recvType = n.childForFieldName("scope")?.text ?? recvType;
        n = n.childForFieldName("name");
      }
      return n && recvType ? { name: n.text, viaMember: true, recvType } : null;
    }
    return null;
  }
  if (lang === "python" && fn.type === "attribute") {
    const a = fn.childForFieldName("attribute") ?? fn.namedChildren.at(-1);
    return a ? { name: a.text, viaMember: true, receiver: pyReceiver(fn) } : null;
  }
  if (lang === "go" && fn.type === "selector_expression") {
    // `pkg.Fn()` / `recv.Method()` — the called name is the trailing field.
    const p = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
    const operand = fn.childForFieldName("operand");
    const receiver = operand?.type === "identifier" ? operand.text : undefined;
    return p ? { name: p.text, viaMember: true, receiver } : null;
  }
  if ((lang === "typescript" || lang === "tsx") && fn.type === "member_expression") {
    const p = fn.childForFieldName("property") ?? fn.namedChildren.at(-1);
    return p ? { name: p.text, viaMember: true, receiver: tsReceiver(fn) } : null;
  }
  return null;
}

/** py `attribute` node's receiver text: bare identifier, or `self.x` for a
 * chained `self.x.y()`. Anything else (e.g. a chained call `f().g()`) → none. */
function pyReceiver(fn: Parser.SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "attribute") {
    const innerObj = obj.childForFieldName("object");
    const innerAttr = obj.childForFieldName("attribute");
    if (innerObj?.type === "identifier" && innerObj.text === "self" && innerAttr) return `self.${innerAttr.text}`;
  }
  return undefined;
}

/** ts `member_expression` node's receiver text: `this`, `this.x`, or a bare identifier. */
function tsReceiver(fn: Parser.SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "this") return "this";
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj?.type === "this" && innerProp) return `this.${innerProp.text}`;
  }
  return undefined;
}

function isImport(node: Parser.SyntaxNode, lang: Language): boolean {
  // Go: match the per-import leaf, so single (`import "fmt"`) and grouped
  // (`import ( … )`) forms each yield one edge as the walk recurses into the list.
  if (lang === "go") return node.type === "import_spec";
  if (lang === "cpp") return node.type === "preproc_include";
  if (lang === "java") return node.type === "import_declaration";
  return node.type === "import_statement" || node.type === "import_from_statement";
}

function importSpecifier(node: Parser.SyntaxNode, lang: Language): string | null {
  if (lang === "python") {
    const m =
      node.childForFieldName("module_name") ??
      node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
    return m?.text ?? null;
  }
  if (lang === "go") {
    // import_spec's `path` is an interpreted_string_literal, e.g. `"mymod/pkg/util"`.
    const path = node.childForFieldName("path") ?? node.namedChildren.at(-1);
    return path ? path.text.replace(/^["`]|["`]$/g, "") : null;
  }
  if (lang === "cpp") {
    // Quoted includes only — `<...>` names a system header by convention, which
    // can never be a repo file, and dangling edges to <cstdio> would be noise.
    const path = node.childForFieldName("path");
    if (path?.type !== "string_literal") return null;
    return path.text.replace(/^"|"$/g, "");
  }
  if (lang === "java") {
    // `import com.game.util.Textures;` — the dotted path; wildcard and static
    // imports keep their raw text and simply fail file resolution downstream.
    const spec = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
    return spec?.text ?? null;
  }
  const str = node.namedChildren.find((c) => c.type === "string");
  if (!str) return null;
  const frag = str.namedChildren.find((c) => c.type === "string_fragment");
  return frag?.text ?? str.text.replace(/^['"]|['"]$/g, "");
}

/** Signature = the definition header, whitespace-collapsed, trailing punctuation stripped. */
function clean(raw: string): string | null {
  const sig = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|[{:=])\s*$/, "")
    .trim();
  return sig || null;
}

/** Java: visibility is spelled on the node — `public` means exported. */
function javaExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  return /\bpublic\b/.test(mods?.text ?? "");
}

/** TS: a definition is exported if any ancestor is an `export` statement. */
function tsExported(node: Parser.SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "export_statement") return true;
    p = p.parent;
  }
  return false;
}
