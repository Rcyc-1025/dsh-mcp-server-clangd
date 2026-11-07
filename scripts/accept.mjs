// 验收脚本：A health / B definition / C diagnostics / D 缺 compile db / E 路径越界，
// 外加 hover/references/symbols 与若干错误码。PASS/FAIL 表格 + 退出码。
// 用法：node scripts/accept.mjs
// 注意：本脚本需要 spawn 子进程；在某些 DSH 沙箱里 Node 管道会被拦成 EPERM，请在普通终端或 danger-full-access 下运行。

import fs from 'node:fs';
import path from 'node:path';
import { McpClient, ROOT } from '../tests/support/client.mjs';
import { ensureFixtures } from '../tests/support/fixtures.mjs';

const REAL_CONFIG = path.join(ROOT, 'clangd-bridge.json');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const TMP = path.join(ROOT, 'tests', '.tmp', 'accept');

const rows = [];

function record(id, name, ok, detail) {
  rows.push({ id, name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

function readClangdPath() {
  if (process.env.CLANGD_PATH && fs.existsSync(process.env.CLANGD_PATH)) return process.env.CLANGD_PATH;
  try {
    const cfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
    if (cfg.clangdPath && fs.existsSync(cfg.clangdPath)) return cfg.clangdPath;
  } catch {
    // 忽略
  }
  return null;
}

const CLANGD = readClangdPath();

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
  let last = null;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function projectHasDb(dir) {
  return fs.existsSync(path.join(dir, 'compile_commands.json'));
}

async function scenarioA() {
  if (!CLANGD) {
    record('A0', 'clangd 可用', false, '未找到 clangd：设置 CLANGD_PATH 或 clangd-bridge.json');
    return;
  }
  if (!fs.existsSync(REAL_CONFIG)) {
    record('A0', '真实配置存在', false, REAL_CONFIG);
    return;
  }
  const client = new McpClient({ configPath: REAL_CONFIG });
  try {
    await client.initialize();
    const staticStarted = Date.now();
    const h1 = await client.callTool('clangd_health', {});
    const staticMs = Date.now() - staticStarted;
    const r1 = h1.result;
    const expectedEntries = projectHasDb(r1.project.compileCommandsDir) ? r1.project.compileCommands.entries : 0;
    record('A1', 'health 静态检查', r1.ok === true && r1.process.state === 'not_started' && staticMs < 1000,
      `state=${r1.process.state} entries=${r1.project.compileCommands.entries}/${expectedEntries} compiler=${r1.project.compileCommands.compilerKind} ms=${staticMs}`);
    record('A1b', 'health 给出 MSVC 警告', r1.warnings.some((w) => w.includes('MSVC')),
      `warnings=${r1.warnings.length}`);
    const h2 = await client.callTool('clangd_health', { start: true });
    const r2 = h2.result;
    record('A2', 'health start:true 预热', r2.ok === true && r2.process.state === 'ready' && r2.process.pid > 0,
      `pid=${r2.process.pid} version=${r2.clangd.version}`);
  } finally {
    await client.close();
  }
}

async function helloScenarios() {
  const cfg = makeConfig('hello', path.join(FIXTURES, 'hello'));
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const tools = await client.listTools();
    record('MCP1', 'tools/list 7 个工具', tools.length === 7, tools.map((t) => t.name).join(','));

    await client.callTool('clangd_health', { start: true });

    const def = await poll(async () => {
      const res = await client.callTool('clangd_definition', { file: 'main.cpp', line: 3, column: 10 });
      const loc = res.result.locations[0];
      return loc && /foo\.cpp$/.test(loc.file) && loc.start.line === 2 && loc.start.column === 5 ? res : null;
    });
    record('B', 'definition main.cpp:3:10 → foo.cpp:2:5', Boolean(def),
      def ? def.result.locations[0].file : '30s 内未命中（background-index 可能未完成）');

    const hover = await client.callTool('clangd_hover', { file: 'main.cpp', line: 3, column: 10 });
    record('F1', 'hover 有内容', hover.result.empty === false && /foo/.test(hover.result.contents || ''), '');

    const refs = await client.callTool('clangd_references', { file: 'foo.cpp', line: 2, column: 5 });
    record('F2', 'references ≥ 2', refs.result.total >= 2, `total=${refs.result.total}`);

    const syms = await client.callTool('clangd_document_symbols', { file: 'main.cpp' });
    record('F3', 'document_symbols 返回 main', syms.result.total === 1 && syms.result.symbols[0].name === 'main', '');

    const ws = await poll(async () => {
      const res = await client.callTool('clangd_workspace_symbols', { query: 'foo', limit: 10 });
      return res.result.symbols.some((s) => s.name === 'foo') ? res : null;
    });
    record('F4', 'workspace_symbols 搜到 foo', Boolean(ws), ws ? `total=${ws.result.total}` : '30s 内未命中');

    const clean = await client.callTool('clangd_diagnostics', { file: 'main.cpp' });
    record('F5', '干净文件 diagnostics 为空且 pending=false', clean.result.pending === false && clean.result.total === 0,
      `total=${clean.result.total}`);

    const outside = await client.callTool('clangd_definition', { file: 'C:/Windows/win.ini', line: 1, column: 1 });
    record('E', '路径越界 → PATH_OUTSIDE_ALLOWED_ROOTS', outside.result.code === 'PATH_OUTSIDE_ALLOWED_ROOTS',
      outside.result.code);

    const oob = await client.callTool('clangd_definition', { file: 'main.cpp', line: 9999, column: 1 });
    record('F6', '行列越界 → POSITION_OUT_OF_RANGE', oob.result.code === 'POSITION_OUT_OF_RANGE', oob.result.code);

    const emptyQuery = await client.callTool('clangd_workspace_symbols', { query: '  ' });
    record('F7', '空 query → INVALID_ARGUMENT', emptyQuery.result.code === 'INVALID_ARGUMENT', emptyQuery.result.code);

    const unknown = await client.request('tools/call', { name: 'clangd_nope', arguments: {} });
    record('F8', '未知工具 → 协议错误 -32602', unknown.error && unknown.error.code === -32602, String(unknown.error && unknown.error.code));
  } finally {
    await client.close();
  }
}

async function brokenScenario() {
  const cfg = makeConfig('broken', path.join(FIXTURES, 'broken'));
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const res = await client.callTool('clangd_diagnostics', { file: 'main.cpp', waitMs: 8000 });
    const errors = res.result.diagnostics.filter((d) => d.severity === 'error');
    const hit = errors.find((d) => /missing_symbol/.test(d.message));
    record('C', 'broken diagnostics（missing_symbol / line 1-based）', Boolean(hit) && hit.range.start.line === 2 && res.result.pending === false,
      hit ? `line=${hit.range.start.line} col=${hit.range.start.column} pending=${res.result.pending}` : '未收到 error 诊断');
  } finally {
    await client.close();
  }
}

async function missingDbScenario() {
  const projectDir = path.join(TMP, 'nodb');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.cpp'), 'int main() { return 0; }\n');
  const cfg = makeConfig('nodb', projectDir, { requireCompileDb: true });
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const started = Date.now();
    const res = await client.callTool('clangd_health', { start: true });
    const elapsed = Date.now() - started;
    record('D', '缺 compile db → COMPILE_COMMANDS_MISSING 且 <500ms', res.result.code === 'COMPILE_COMMANDS_MISSING' && elapsed < 500,
      `code=${res.result.code} ms=${elapsed}`);
  } finally {
    await client.close();
  }
}

async function invalidDbScenario() {
  const projectDir = path.join(TMP, 'baddb');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'a.cpp'), 'int main() { return 0; }\n');
  fs.writeFileSync(path.join(projectDir, 'compile_commands.json'), '{ not json');
  const cfg = makeConfig('baddb', projectDir);
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const res = await client.callTool('clangd_definition', { file: 'a.cpp', line: 1, column: 1 });
    record('G1', '损坏 compile db → COMPILE_COMMANDS_INVALID', res.result.code === 'COMPILE_COMMANDS_INVALID', res.result.code);
  } finally {
    await client.close();
  }
}

async function badClangdScenario() {
  const cfg = makeConfig('badclangd', path.join(FIXTURES, 'hello'), { clangdPath: 'C:/definitely/not/clangd.exe' });
  const client = new McpClient({ configPath: cfg });
  try {
    await client.initialize();
    const res = await client.callTool('clangd_health', { start: true });
    record('G2', '错误 clangd 路径 → CLANGD_NOT_FOUND', res.result.code === 'CLANGD_NOT_FOUND', res.result.code);
  } finally {
    await client.close();
  }
}

async function main() {
  if (!CLANGD) {
    console.log('未找到 clangd：请设置 CLANGD_PATH，或在 clangd-bridge.json 里配置 clangdPath。');
    process.exit(2);
  }
  console.log(`clangd: ${CLANGD}\nnode: ${process.version}\n`);

  ensureFixtures();

  await scenarioA();
  await helloScenarios();
  await brokenScenario();
  await missingDbScenario();
  await invalidDbScenario();
  await badClangdScenario();

  const failed = rows.filter((r) => !r.ok);
  console.log(`\n合计 ${rows.length} 项：PASS ${rows.length - failed.length} / FAIL ${failed.length}`);
  if (failed.length > 0) {
    console.log(`失败项：${failed.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
