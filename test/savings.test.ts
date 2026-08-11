/**
 * Tests for the graft usage marker ({@link coverageFor} + {@link withGraftLine})
 * that every retrieval-style command routes through.
 *
 * This used to print a "tokens saved ≈ N (P%)" estimate whose baseline was
 * "you'd have read every covered file in full". Nobody does that — the real
 * alternative to `graft grep` is one `grep -rn`, not opening twelve files — so
 * the number ran an order of magnitude high and the agent then repeated it to
 * the user as fact. The honest signal is simply that graft answered, plus how
 * much of the repo the answer covers; that is what the line carries now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageFor, graftLine, withGraftLine, GRAFT_MARKER } from '../src/context/savings.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

function fileNode(path: string, chars?: number): NodeV1 {
  return {
    id: path,
    name: path,
    kind: 'file',
    path,
    span: 'L1-L1',
    signature: null,
    exported: true,
    origin: 'ast',
    body_hash: '',
    summary_state: 'pending',
    summary: null,
    crux: null,
    chars,
  };
}

function graphOf(nodes: NodeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
}

test('coverageFor: counts the distinct indexed files an answer covers', () => {
  const g = graphOf([fileNode('a.ts', 400), fileNode('b.ts', 600)]);
  assert.deepEqual(coverageFor(g, ['a.ts', 'b.ts', 'a.ts']), { files: 2 }); // duplicate counted once
});

test('coverageFor: unsized files still count; unknown paths never do', () => {
  // Sizes were only ever needed for the token math that is gone, so a
  // pre-`chars` graph is now counted like any other rather than under-reported.
  const g = graphOf([fileNode('a.ts'), fileNode('b.ts', 800)]);
  assert.deepEqual(coverageFor(g, ['a.ts', 'b.ts']), { files: 2 });
  assert.equal(coverageFor(g, ['missing.ts']), undefined);
});

test('graftLine: says graft answered, and how much it covers — no token claims', () => {
  const line = graftLine({ files: 12 });
  assert.ok(line.startsWith(GRAFT_MARKER), `must start with the marker: ${line}`);
  assert.match(line, /12 file\(s\)/);
  // The whole point of the change: no fabricated savings, no percentage, and no
  // instruction telling the agent to repeat a total it cannot verify.
  assert.doesNotMatch(line, /saved/i);
  assert.doesNotMatch(line, /\d+%/);
  assert.doesNotMatch(line, /tok\b/);
  assert.doesNotMatch(line, /end of your reply/i);
  assert.equal(line.split('\n').length, 1, 'stays one line');
});

test('graftLine: still marks usage when there is no coverage to report', () => {
  assert.equal(graftLine(undefined), GRAFT_MARKER);
});

test('graftLine: exactly one marker, so the call counter cannot double-count', () => {
  const line = graftLine({ files: 3 });
  assert.equal((line.match(new RegExp(GRAFT_MARKER.replace('[', '\\['), 'g')) ?? []).length, 1);
});

test('withGraftLine: marker on top, body intact', () => {
  // Header, not footer: agents pipe graft through `head -N` and hosts truncate
  // from the end, so a trailing marker gets eaten.
  const out = withGraftLine('BODY', { files: 2 });
  assert.ok(out.startsWith(GRAFT_MARKER), out);
  assert.ok(out.endsWith('BODY'), out);
  assert.equal(withGraftLine('BODY', undefined).endsWith('BODY'), true);
});
