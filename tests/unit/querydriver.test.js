import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryDriverProblem, expandGlobPattern } from '../../src/paths.js';

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qd-${name}-`));
}

function toPattern(p) {
  return p.split('\\').join('/');
}

test('expandGlobPattern 只返回已存在的路径', () => {
  const root = tmpDir('glob');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'clang.exe'), 'x');
  fs.writeFileSync(path.join(root, 'bin', 'clang++.exe'), 'x');
  const matches = expandGlobPattern(toPattern(path.join(root, 'bin', 'clang*'))).map((p) => path.basename(p)).sort();
  assert.deepEqual(matches, ['clang++.exe', 'clang.exe']);
  assert.deepEqual(expandGlobPattern(toPattern(path.join(root, 'nope', '*'))), []);
});

test('queryDriver 含 .. 的条目一律拒绝（即使静态前缀在允许根内）', () => {
  const root = tmpDir('dots');
  const pattern = `${toPattern(path.join(root, 'allowed'))}/*/../../Windows/clang.exe`;
  const problem = queryDriverProblem(pattern, [root]);
  assert.ok(problem, '应拒绝 .. 段');
  assert.match(problem, /\.\./);
});

test('queryDriver 的通配匹配项 realpath 后必须仍在 allowedRoots 内', (t) => {
  const root = tmpDir('symlink');
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(allowed, 'bin'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'clang.exe'), 'x');
  fs.writeFileSync(path.join(allowed, 'bin', 'clang.exe'), 'x');

  // 正常匹配（根内）通过
  assert.equal(queryDriverProblem(toPattern(path.join(allowed, 'bin', '*')), [allowed]), null);

  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(allowed, 'link'), 'junction');
    linked = true;
  } catch {
    // 某些 Windows 环境禁止创建联接/符号链接：跳过该分支
  }
  if (!linked) {
    t.skip('当前环境无法创建目录联接');
    return;
  }
  const problem = queryDriverProblem(toPattern(path.join(allowed, 'link', 'clang.exe')), [allowed]);
  assert.ok(problem, '匹配项解析到允许根之外应被拒绝');
  assert.match(problem, /allowedRoots/);
});

test('queryDriver 指向允许根之外时拒绝', () => {
  const root = tmpDir('outside');
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'clang.exe'), 'x');
  const problem = queryDriverProblem(toPattern(path.join(outside, '*')), [allowed]);
  assert.ok(problem);
  assert.match(problem, /allowedRoots/);
});
