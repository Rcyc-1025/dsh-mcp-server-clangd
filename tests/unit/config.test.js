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
  assert.equal(loaded.config.queryDriverRequested, 'C:/clang/bin/*');
  assert.equal(loaded.config.queryDriverIssue, 'allowQueryDriver 不为 true');
  assert.ok(loaded.warnings.some((w) => w.includes('allowQueryDriver')));
});

test('queryDriver 在 allowedRoots 内且已授权时启用', () => {
  const cwd = tmpProject('querydriver-ok');
  const bin = path.join(cwd, 'tools', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const queryDriver = path.join(bin, '*').split('\\').join('/');
  fs.writeFileSync(
    path.join(cwd, 'clangd-bridge.json'),
    JSON.stringify({ projectRoot: cwd, allowQueryDriver: true, queryDriver }),
  );
  const loaded = loadConfig({ argv: [], env: {}, cwd });
  assert.equal(loaded.config.queryDriver, queryDriver);
  assert.equal(loaded.config.queryDriverIssue, null);
  assert.equal(loaded.warnings.some((w) => w.includes('queryDriver 已禁用')), false);
});

test('queryDriver 指向 allowedRoots 之外时被禁用并告警', () => {
  const cwd = tmpProject('querydriver-out');
  fs.mkdirSync(path.join(cwd, 'proj'), { recursive: true });
  const outside = path.join(cwd, 'outside', 'bin');
  fs.mkdirSync(outside, { recursive: true });
  const queryDriver = path.join(outside, '*').split('\\').join('/');
  fs.writeFileSync(
    path.join(cwd, 'clangd-bridge.json'),
    JSON.stringify({ projectRoot: path.join(cwd, 'proj'), allowQueryDriver: true, queryDriver }),
  );
  const loaded = loadConfig({ argv: [], env: {}, cwd });
  assert.equal(loaded.config.queryDriver, null);
  assert.match(loaded.config.queryDriverIssue, /allowedRoots/);
  assert.ok(loaded.warnings.some((w) => w.includes('queryDriver 已禁用')));
});

test('log.dir 在 projectRoot 内时保留，在 projectRoot 与系统临时目录之外时回落默认目录', () => {
  const cwd = tmpProject('logdir');
  const project = path.join(cwd, 'proj');
  const logs = path.join(project, 'logs');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'clangd-bridge.json'),
    JSON.stringify({ projectRoot: project, log: { dir: logs } }),
  );
  const loaded = loadConfig({ argv: [], env: {}, cwd });
  assert.equal(loaded.config.log.dir, logs);
  assert.equal(loaded.warnings.some((w) => w.includes('log.dir')), false);

  const cwd2 = tmpProject('logdir-out');
  const project2 = path.join(cwd2, 'proj');
  fs.mkdirSync(project2, { recursive: true });
  fs.writeFileSync(
    path.join(cwd2, 'clangd-bridge.json'),
    JSON.stringify({ projectRoot: project2, log: { dir: path.parse(cwd2).root } }),
  );
  const loaded2 = loadConfig({ argv: [], env: {}, cwd: cwd2 });
  assert.equal(loaded2.config.log.dir, path.join(os.tmpdir(), 'dsh-clangd-bridge', 'logs'));
  assert.ok(loaded2.warnings.some((w) => w.includes('log.dir 必须位于 projectRoot 或系统临时目录内')));
});
