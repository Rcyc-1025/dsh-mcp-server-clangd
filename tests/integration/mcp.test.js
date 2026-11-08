// 集成测试：真实 spawn MCP server + clangd（fixtures/hello、fixtures/broken）。
// 没有 clangd 时整组 skip，不阻塞纯逻辑测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { McpClient, ROOT } from '../support/client.mjs';
import { ensureFixtures } from '../support/fixtures.mjs';

function readRealClangd() {
  if (process.env.CLANGD_PATH && fs.existsSync(process.env.CLANGD_PATH)) return process.env.CLANGD_PATH;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'clangd-bridge.json'), 'utf8'));
    if (cfg.clangdPath && fs.existsSync(cfg.clangdPath)) return cfg.clangdPath;
  } catch {
    // 忽略
  }
  return null;
}

const CLANGD = readRealClangd();
const skip = CLANGD ? false : '未找到 clangd（设置 CLANGD_PATH 或 clangd-bridge.json）';

const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const TMP = path.join(ROOT, 'tests', '.tmp', 'integration');

// fixtures 里的 compile_commands.json 不入库，跑测试前按本机编译器与目录生成。
ensureFixtures();

function makeConfig(name, projectDir, extra = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const configPath = path.join(TMP, `${name}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      clangdPath: CLANGD,
      projectRoot: projectDir,
      compileCommandsDir: projectDir,
      allowedRoots: [FIXTURES, projectDir],
      backgroundIndex: true,
      diagnosticsWaitMs: 5000,
      ...extra,
    }, null, 2),
  );
  return configPath;
}

async function poll(fn, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('MCP 协议 + 工具（真实 clangd）', { skip }, async (t) => {
  const helloCfg = makeConfig('hello', path.join(FIXTURES, 'hello'));
  const client = new McpClient({ configPath: helloCfg });

  try {
    await t.test('initialize 不启动 clangd 且声明 tools', async () => {
      const res = await client.initialize();
      assert.equal(res.result.serverInfo.name, 'clangd-bridge');
      assert.equal(res.result.serverInfo.version, '0.1.0');
      assert.ok(res.result.capabilities.tools);
      const health = await client.callTool('clangd_health', {});
      assert.equal(health.result.process.state, 'not_started');
      assert.equal(health.result.project.compileCommands.entries, 2);
      assert.equal(health.result.project.compileCommands.compilerKind, 'clang');
    });

    await t.test('tools/list 暴露 7 个工具', async () => {
      const tools = await client.listTools();
      assert.deepEqual(tools.map((x) => x.name), [
        'clangd_health',
        'clangd_definition',
        'clangd_hover',
        'clangd_references',
        'clangd_diagnostics',
        'clangd_document_symbols',
        'clangd_workspace_symbols',
      ]);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.annotations.readOnlyHint, true);
      }
    });

    await t.test('health start:true 启动并就绪', async () => {
      const health = await client.callTool('clangd_health', { start: true });
      assert.equal(health.result.ok, true);
      assert.equal(health.result.process.state, 'ready');
      assert.ok(health.result.process.pid > 0);
    });

    await t.test('definition 从调用点跳到 foo.cpp 定义（需要 background-index）', async () => {
      const found = await poll(async () => {
        const res = await client.callTool('clangd_definition', { file: 'main.cpp', line: 3, column: 10 });
        const loc = res.result.locations[0];
        return loc && /foo\.cpp$/.test(loc.file) && loc.start.line === 2 && loc.start.column === 5 ? res : null;
      });
      assert.ok(found, '30s 内 definition 未指向 foo.cpp:2:5');
      assert.equal(found.isError, false);
      assert.match(found.result.locations[0].uri, /foo\.cpp$/);
    });

    await t.test('hover 返回函数签名', async () => {
      const res = await client.callTool('clangd_hover', { file: 'main.cpp', line: 3, column: 10 });
      assert.equal(res.result.empty, false);
      assert.match(res.result.contents, /foo/);
      assert.equal(res.result.position.line, 3);
    });

    await t.test('references 包含定义与调用', async () => {
      const res = await client.callTool('clangd_references', { file: 'foo.cpp', line: 2, column: 5 });
      assert.ok(res.result.total >= 2);
      const keys = res.result.locations.map((r) => `${r.file}:${r.start.line}:${r.start.column}`);
      assert.ok(keys.some((k) => k.endsWith('foo.cpp:2:5')), keys.join(','));
      assert.ok(keys.some((k) => k.endsWith('main.cpp:3:10')), keys.join(','));
    });

    await t.test('document_symbols 返回 main', async () => {
      const res = await client.callTool('clangd_document_symbols', { file: 'main.cpp' });
      assert.equal(res.result.total, 1);
      assert.equal(res.result.symbols[0].name, 'main');
      assert.equal(res.result.symbols[0].kind, 'function');
    });

    await t.test('workspace_symbols 能搜到 foo', async () => {
      const found = await poll(async () => {
        const res = await client.callTool('clangd_workspace_symbols', { query: 'foo', limit: 10 });
        return res.result.symbols.some((s) => s.name === 'foo') ? res : null;
      });
      assert.ok(found, '30s 内 workspace_symbols 未搜到 foo');
    });

    await t.test('diagnostics 干净文件 pending=false 且为空', async () => {
      const res = await client.callTool('clangd_diagnostics', { file: 'main.cpp' });
      assert.equal(res.result.pending, false);
      assert.equal(res.result.total, 0);
    });

    await t.test('工具输出在顶层暴露 truncated（规格 §6.3/§7.2/§7.4/§7.6/§7.7）', async () => {
      const calls = [
        ['clangd_definition', { file: 'main.cpp', line: 3, column: 10 }],
        ['clangd_references', { file: 'foo.cpp', line: 2, column: 5 }],
        ['clangd_diagnostics', { file: 'main.cpp', waitMs: 0 }],
        ['clangd_document_symbols', { file: 'main.cpp' }],
        ['clangd_workspace_symbols', { query: 'foo', limit: 10 }],
      ];
      for (const [tool, args] of calls) {
        const res = await client.callTool(tool, args);
        assert.equal(typeof res.result.truncated, 'boolean', `${tool} 缺顶层 truncated`);
        assert.equal(res.result.meta.truncated, res.result.truncated, `${tool} meta.truncated 不一致`);
      }
      const refs = await client.callTool('clangd_references', { file: 'foo.cpp', line: 2, column: 5 });
      assert.ok(Array.isArray(refs.result.locations), 'references 顶层必须是 locations');
      assert.equal(refs.result.references, undefined, 'references 不应再输出旧字段名');
      const health = await client.callTool('clangd_health', {});
      const ids = health.result.checks.map((c) => c.id);
      assert.ok(ids.includes('log.dir'), 'health 缺 log.dir 检查');
      assert.ok(ids.includes('queryDriver'), 'health 缺 queryDriver 检查');
    });

    await t.test('业务错误 isError=false 且带 code/hint', async () => {
      const outside = await client.callTool('clangd_definition', { file: 'C:/Windows/win.ini', line: 1, column: 1 });
      assert.equal(outside.isError, false);
      assert.equal(outside.result.code, 'PATH_OUTSIDE_ALLOWED_ROOTS');
      assert.ok(outside.result.hint.length > 0);

      const oob = await client.callTool('clangd_definition', { file: 'main.cpp', line: 9999, column: 1 });
      assert.equal(oob.result.code, 'POSITION_OUT_OF_RANGE');

      const missing = await client.callTool('clangd_definition', { file: 'nope.cpp', line: 1, column: 1 });
      assert.equal(missing.result.code, 'FILE_NOT_FOUND');

      const emptyQuery = await client.callTool('clangd_workspace_symbols', { query: '   ' });
      assert.equal(emptyQuery.result.code, 'INVALID_ARGUMENT');

      const longQuery = await client.callTool('clangd_workspace_symbols', { query: 'x'.repeat(129) });
      assert.equal(longQuery.result.code, 'QUERY_TOO_LONG');

      const badLimit = await client.callTool('clangd_workspace_symbols', { query: 'foo', limit: 0 });
      assert.equal(badLimit.result.code, 'LIMIT_OUT_OF_RANGE');
    });

    await t.test('未知工具与未知方法走协议错误', async () => {
      const unknownTool = await client.request('tools/call', { name: 'clangd_nope', arguments: {} });
      assert.equal(unknownTool.error.code, -32602);

      const unknownMethod = await client.request('nope/method', {});
      assert.equal(unknownMethod.error.code, -32601);
    });
  } finally {
    await client.close();
  }
});

test('broken fixture 返回 undeclared identifier 诊断', { skip }, async (t) => {
  const cfg = makeConfig('broken', path.join(FIXTURES, 'broken'));
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const res = await client.callTool('clangd_diagnostics', { file: 'main.cpp', waitMs: 8000 });
    assert.equal(res.result.pending, false);
    const errors = res.result.diagnostics.filter((d) => d.severity === 'error');
    assert.ok(errors.length >= 1, JSON.stringify(res.result.diagnostics));
    assert.match(errors[0].message, /missing_symbol/);
    assert.equal(errors[0].range.start.line, 2);
    assert.equal(errors[0].range.start.column, 10);
  } finally {
    await client.close();
  }
});

test('缺 compile_commands.json 时快速失败且不启动进程', { skip }, async (t) => {
  const projectDir = path.join(TMP, 'nodb');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.cpp'), 'int main() { return 0; }\n');
  const cfg = makeConfig('nodb', projectDir);
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const started = Date.now();
    const res = await client.callTool('clangd_health', { start: true });
    const elapsed = Date.now() - started;
    assert.equal(res.result.code, 'COMPILE_COMMANDS_MISSING');
    assert.ok(elapsed < 2000, `耗时 ${elapsed}ms 过长`);
    assert.equal(res.result.process, undefined);
  } finally {
    await client.close();
  }
});
