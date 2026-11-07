import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterDiagnostics,
  normalizeDefinition,
  normalizeDiagnostic,
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeReferences,
  normalizeWorkspaceSymbols,
} from '../../src/lsp/normalize.js';

const URI_A = 'file:///D:/work/a.cpp';
const URI_B = 'file:///D:/work/b.cpp';

test('normalizeDefinition 支持 Location 与 LocationLink', () => {
  const loc = normalizeDefinition({
    uri: URI_A,
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
  });
  assert.equal(loc.length, 1);
  assert.equal(loc[0].file, 'D:/work/a.cpp');
  assert.deepEqual(loc[0].start, { line: 2, column: 3 });
  assert.deepEqual(loc[0].end, { line: 2, column: 6 });

  const link = normalizeDefinition({
    targetUri: URI_B,
    targetRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
    targetSelectionRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } },
  });
  assert.equal(link.length, 1);
  assert.equal(link[0].file, 'D:/work/b.cpp');
  assert.deepEqual(link[0].start, { line: 4, column: 5 });
  assert.deepEqual(link[0].targetRange.start, { line: 1, column: 1 });
});

test('normalizeDefinition 空结果返回 []', () => {
  assert.deepEqual(normalizeDefinition(null), []);
  assert.deepEqual(normalizeDefinition([]), []);
});

test('normalizeReferences 按文件/行/列排序并解析路径', () => {
  const refs = normalizeReferences([
    { uri: URI_B, range: { start: { line: 4, character: 1 }, end: { line: 4, character: 2 } } },
    { uri: URI_A, range: { start: { line: 9, character: 1 }, end: { line: 9, character: 2 } } },
    { uri: URI_A, range: { start: { line: 2, character: 5 }, end: { line: 2, character: 8 } } },
  ]);
  assert.deepEqual(refs.map((r) => [r.file, r.start.line, r.start.column]), [
    ['D:/work/a.cpp', 3, 6],
    ['D:/work/a.cpp', 10, 2],
    ['D:/work/b.cpp', 5, 2],
  ]);
});

test('normalizeHover 拼接 MarkupContent 与 MarkedString', () => {
  const hover = normalizeHover({
    contents: [
      '### function `foo`',
      { kind: 'markdown', value: '```cpp\nint foo(int)\n```' },
    ],
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  });
  assert.equal(hover.empty, false);
  assert.equal(hover.kind, 'markdown');
  assert.match(hover.contents, /function `foo`/);
  assert.match(hover.contents, /int foo\(int\)/);
  assert.deepEqual(hover.range.start, { line: 1, column: 1 });

  const empty = normalizeHover(null);
  assert.equal(empty.empty, true);
  assert.equal(empty.contents, '');
});

test('normalizeDiagnostic 映射 severity 与 relatedInformation', () => {
  const base = {
    severity: 1,
    message: 'boom',
    code: 'err_code',
    source: 'clang',
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
  };
  const error = normalizeDiagnostic(base, { includeRelated: true });
  assert.equal(error.severity, 'error');
  assert.equal(error.code, 'err_code');
  assert.deepEqual(error.range.start, { line: 2, column: 3 });
  assert.deepEqual(error.relatedInformation, []);

  const unknown = normalizeDiagnostic({ message: 'x', range: base.range });
  assert.equal(unknown.severity, 'unknown');

  const withRelated = normalizeDiagnostic(
    {
      ...base,
      severity: 2,
      relatedInformation: [{ message: 'note', location: { uri: URI_A, range: base.range } }],
    },
    { includeRelated: true },
  );
  assert.equal(withRelated.severity, 'warning');
  assert.equal(withRelated.relatedInformation.length, 1);
  assert.equal(withRelated.relatedInformation[0].file, 'D:/work/a.cpp');
});

test('filterDiagnostics 按严重级别过滤（大小写/未知值原样保留）', () => {
  const list = [
    { severity: 1, message: 'e', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    { severity: 2, message: 'w', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ];
  assert.equal(filterDiagnostics(list, 'error').length, 1);
  assert.equal(filterDiagnostics(list, null).length, 2);
});

function sym(name, children = []) {
  return {
    name,
    kind: 12,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    children,
  };
}

test('normalizeDocumentSymbols 层次树与 DFS 截断', () => {
  const tree = [sym('a', [sym('a1'), sym('a2', [sym('a2x')])]), sym('b')];
  const full = normalizeDocumentSymbols(tree, 100);
  assert.equal(full.hierarchical, true);
  assert.equal(full.total, 5);
  assert.equal(full.truncated, false);
  assert.equal(full.symbols.length, 2);
  assert.equal(full.symbols[0].children.length, 2);

  const cut = normalizeDocumentSymbols(tree, 2);
  assert.equal(cut.truncated, true);
  assert.equal(cut.total, 5);
  let count = 0;
  const walk = (nodes) => nodes.forEach((n) => {
    count += 1;
    walk(n.children || []);
  });
  walk(cut.symbols);
  assert.equal(count, 2);
  assert.equal(cut.symbols[0].name, 'a');
  assert.equal(cut.symbols[0].children[0].name, 'a1');
});

test('normalizeDocumentSymbols flat 结果', () => {
  const flat = [
    { name: 'f', kind: 12, containerName: 'ns', location: { uri: URI_A, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
  ];
  const out = normalizeDocumentSymbols(flat, 10);
  assert.equal(out.hierarchical, false);
  assert.equal(out.symbols[0].file, 'D:/work/a.cpp');
  assert.equal(out.symbols[0].containerName, 'ns');
});

test('normalizeWorkspaceSymbols limit 与 truncated', () => {
  const list = [
    { name: 'A', kind: 12, location: { uri: URI_A, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
    { name: 'B', kind: 12 },
  ];
  const out = normalizeWorkspaceSymbols(list, 1);
  assert.equal(out.total, 2);
  assert.equal(out.symbols.length, 1);
  assert.equal(out.truncated, true);
  assert.equal(out.symbols[0].start.line, 1);

  const noLoc = normalizeWorkspaceSymbols([{ name: 'C', kind: 12 }], 10);
  assert.equal(noLoc.symbols[0].start, null);
  assert.equal(noLoc.symbols[0].file, null);
});
