import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseCliArgs } from '../../src/config.js';

function tmpProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cfg-${name}-`));
  return dir;
}

test('parseCliArgs 支持 --config/-c/--config=/--print-config', () => {
  assert.deepEqual(parseCliArgs(['--config', 'a.json']), { configPath: 'a.json', printConfig: false });
  assert.deepEqual(parseCliArgs(['-c', 'b.json', '--print-config']), { configPath: 'b.json', printConfig: true });
  assert.deepEqual(parseCliArgs(['--config=c.json']), { configPath: 'c.json', printConfig: false });
});

test('无配置时使用默认值且不抛异常（缺 projectRoot）', () => {
  const cwd = tmpProject('defaults');
  const loaded = loadConfig({ argv: [], env: {}, cwd });
  assert.equal(loaded.configured, false);
  assert.equal(loaded.config.projectRoot, null);
  assert.equal(loaded.config.requireCompileDb, true);
  assert.equal(loaded.config.maxResults, 200);
  assert.equal(loaded.config.maxFileBytes, 8388608);
  assert.deepEqual(loaded.config.allowedRoots, []);
  assert.equal(loaded.configPath, null);
});

test('读取 cwd/clangd-bridge.json 并解析 projectRoot / compileCommandsDir', () => {
  const cwd = tmpProject('file');
  const project = path.join(cwd, 'proj');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(cwd, 'clangd-bridge.json'), JSON.stringify({ projectRoot: './proj' }));
  const loaded = loadConfig({ argv: [], env: {}, cwd });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.config.projectRoot, project);
  assert.equal(loaded.config.compileCommandsDir, project);
  assert.deepEqual(loaded.config.allowedRoots, [project]);
});

test('环境变量覆盖文件配置，allowedRoots 用分号分隔', () => {
  const cwd = tmpProject('env');
  const project = path.join(cwd, 'p2');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(cwd, 'clangd-bridge.json'), JSON.stringify({ projectRoot: './ignored' }));
  const loaded = loadConfig({
    argv: [],
    env: {
      CLANGD_PROJECT_ROOT: project,
      CLANGD_ALLOWED_ROOTS: `${project};${path.join(cwd, 'extra')}`,
      CLANGD_REQUEST_TIMEOUT_MS: '45000',
      CLANGD_LOG_LEVEL: 'debug',
      CLANGD_PATH: path.join(cwd, 'clangd.exe'),
    },
    cwd,
  });
  assert.equal(loaded.config.projectRoot, project);
  assert.equal(loaded.config.requestTimeoutMs, 45000);
  assert.equal(loaded.config.log.level, 'debug');
  assert.equal(loaded.config.clangdPath, path.join(cwd, 'clangd.exe'));
  assert.equal(loaded.config.clangdPathSource, 'env');
  assert.equal(loaded.config.allowedRoots.length, 2);
  assert.ok(loaded.warnings.some((w) => w.includes('allowedRoots 条目不存在')));
});

test('非法 JSON / 非对象顶层抛 CONFIG_INVALID', () => {
  const cwd = tmpProject('badjson');
  fs.writeFileSync(path.join(cwd, 'clangd-bridge.json'), '{oops');
  assert.throws(() => loadConfig({ argv: [], env: {}, cwd }), (err) => err.code === 'CONFIG_INVALID');

  const cwd2 = tmpProject('array');
  fs.writeFileSync(path.join(cwd2, 'clangd-bridge.json'), '[]');
  assert.throws(() => loadConfig({ argv: [], env: {}, cwd: cwd2 }), (err) => err.code === 'CONFIG_INVALID');
});

test('env 键白名单与类型校验', () => {
  const cwd = tmpProject('envkeys');
  fs.writeFileSync(
    path.join(cwd, 'clangd-bridge.json'),
    JSON.stringify({ projectRoot: cwd, env: { SECRET: 'x' } }),
  );
  assert.throws(() => loadConfig({ argv: [], env: {}, cwd }), (err) => err.code === 'CONFIG_INVALID');

  const cwd2 = tmpProject('bool');
  fs.writeFileSync(path.join(cwd2, 'clangd-bridge.json'), JSON.stringify({ projectRoot: cwd2, clangTidy: 'maybe' }));
  assert.throws(() => loadConfig({ argv: [], env: {}, cwd: cwd2 }), (err) => err.code === 'CONFIG_INVALID');
});

test('queryDriver 未授权时被忽略并告警', () => {
  const cwd = tmpProject('querydriver');
  fs.writeFileSync(
    path.join(cwd, 'clangd-bridge.json'),
    JSON.stringify({ projectRoot: cwd, queryDriver: 'C:/clang/bin/*' }),
  );
  const loaded = loadConfig({ argv: [], env: {}, cwd });
  assert.equal(loaded.config.queryDriver, null);
  assert.ok(loaded.warnings.some((w) => w.includes('allowQueryDriver')));
});
