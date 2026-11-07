import test from 'node:test';
import assert from 'node:assert/strict';
import { fromLspPosition, fromLspRange, splitLines, toLspPosition } from '../../src/paths.js';

test('splitLines 处理 CRLF/CR/LF', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines('a\n'), ['a', '']);
});

test('toLspPosition 1-based → 0-based', () => {
  const content = 'int main() {\n  return 0;\n}\n';
  assert.deepEqual(toLspPosition(content, 2, 3), { line: 1, character: 2 });
  assert.deepEqual(toLspPosition(content, 1, 1), { line: 0, character: 0 });
});

test('toLspPosition 允许停在行尾（column = 长度 + 1）', () => {
  assert.deepEqual(toLspPosition('abc', 1, 4), { line: 0, character: 3 });
});

test('toLspPosition 越界报 POSITION_OUT_OF_RANGE', () => {
  assert.throws(() => toLspPosition('abc', 2, 1), (err) => err.code === 'POSITION_OUT_OF_RANGE');
  assert.throws(() => toLspPosition('abc', 1, 5), (err) => err.code === 'POSITION_OUT_OF_RANGE');
  assert.throws(() => toLspPosition('abc', 0, 1), (err) => err.code === 'POSITION_OUT_OF_RANGE');
  assert.throws(() => toLspPosition('abc', 1, 0), (err) => err.code === 'POSITION_OUT_OF_RANGE');
});

test('UTF-16 列偏移：中文按 UTF-16 单元计数', () => {
  // '中文' 长度为 2（代理对字符才占 2 单元）
  assert.deepEqual(toLspPosition('中文', 1, 3), { line: 0, character: 2 });
  assert.deepEqual(toLspPosition('😀x', 1, 4), { line: 0, character: 3 });
});

test('fromLspPosition / fromLspRange 回到 1-based', () => {
  assert.deepEqual(fromLspPosition({ line: 1, character: 2 }), { line: 2, column: 3 });
  assert.deepEqual(
    fromLspRange({ start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }),
    { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
  );
  assert.equal(fromLspPosition(null), null);
  assert.equal(fromLspRange({}), null);
});
