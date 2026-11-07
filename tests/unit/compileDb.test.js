import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCompilerKind, inspectCompileDb, isMsvcDb } from '../../src/compileDb.js';

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cdb-${name}-`));
  return dir;
}

function writeDb(dir, content) {
  fs.writeFileSync(path.join(dir, 'compile_commands.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

test('detectCompilerKind 识别 msvc / clang / gcc', () => {
  assert.equal(detectCompilerKind({ arguments: ['C:/VS/cl.exe', '-c', 'a.cpp'] }).kind, 'msvc');
  assert.equal(detectCompilerKind({ arguments: ['clang-cl.exe', '-c'] }).kind, 'msvc');
  assert.equal(detectCompilerKind({ arguments: ['/usr/bin/clang++', '-c'] }).kind, 'clang');
  assert.equal(detectCompilerKind({ command: '"C:/Program Files/LLVM/bin/clang++.exe" -c a.cpp' }).kind, 'clang');
  assert.equal(detectCompilerKind({ command: 'g++ -c a.cpp' }).kind, 'gcc');
  assert.equal(detectCompilerKind({ command: 'cc -c a.cpp' }).kind, 'gcc');
  assert.equal(detectCompilerKind({}).kind, 'unknown');
});

test('inspectCompileDb：目录/文件不存在', () => {
  const missing = inspectCompileDb(path.join(os.tmpdir(), 'definitely-missing-dir-xyz'));
  assert.equal(missing.exists, false);
  assert.equal(missing.valid, false);
  assert.equal(inspectCompileDb(null).exists, false);
});

test('inspectCompileDb：合法 db', () => {
  const dir = tmpDir('valid');
  writeDb(dir, [
    {
      directory: dir,
      file: 'a.cpp',
      arguments: ['C:/LLVM/bin/clang++.exe', '-std=c++17', '-c', 'a.cpp'],
    },
    {
      directory: dir,
      file: 'b.cpp',
      command: 'g++ -c b.cpp',
    },
  ]);
  const status = inspectCompileDb(dir);
  assert.equal(status.exists, true);
  assert.equal(status.valid, true);
  assert.equal(status.entries, 2);
  assert.equal(status.compilerKind, 'clang');
  assert.match(status.firstCompiler, /clang\+\+\.exe$/);
  assert.equal(isMsvcDb(status), false);
});

test('inspectCompileDb：MSVC db 触发 isMsvcDb', () => {
  const dir = tmpDir('msvc');
  writeDb(dir, [{ directory: dir, file: 'a.cpp', arguments: ['cl.exe', '/c', 'a.cpp'] }]);
  const status = inspectCompileDb(dir);
  assert.equal(status.valid, true);
  assert.equal(status.compilerKind, 'msvc');
  assert.equal(isMsvcDb(status), true);
});

test('inspectCompileDb：JSON 非法 / 顶层非数组 / 空数组', () => {
  const bad = tmpDir('badjson');
  writeDb(bad, '{ not json');
  assert.equal(inspectCompileDb(bad).valid, false);
  assert.match(inspectCompileDb(bad).error, /JSON 解析失败/);

  const obj = tmpDir('obj');
  writeDb(obj, { a: 1 });
  assert.match(inspectCompileDb(obj).error, /不是数组/);

  const empty = tmpDir('empty');
  writeDb(empty, []);
  assert.match(inspectCompileDb(empty).error, /数组为空/);
});

test('inspectCompileDb：条目缺字段时给出 invalidEntries', () => {
  const dir = tmpDir('entries');
  writeDb(dir, [
    { directory: dir, file: 'a.cpp', arguments: ['clang++', '-c', 'a.cpp'] },
    { directory: dir, arguments: ['clang++'] },
    { file: 'c.cpp', command: 'clang++ -c c.cpp' },
  ]);
  const status = inspectCompileDb(dir);
  assert.equal(status.valid, false);
  assert.equal(status.entries, 3);
  assert.equal(status.invalidEntries.length, 2);
  assert.match(status.error, /条目缺少必需字段/);
});
