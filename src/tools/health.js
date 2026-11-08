// clangd_health：自检。默认不启动常驻 clangd，只做静态检查 + 一次短命 --version。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { inspectCompileDb, isMsvcDb } from '../compileDb.js';
import { resolveClangdPath } from '../config.js';
import { isInsideRoot, realpathLoose } from '../paths.js';
import { asArgs, boolArg, metaFor } from './common.js';

export const name = 'clangd_health';

export const description =
  '自检 clangd 桥：检查 clangd 可执行文件/版本、compile_commands.json、进程状态与风险警告。默认不启动常驻进程（start:false）；start:true 会预热并完成 initialize。';

export const inputSchema = {
  type: 'object',
  properties: {
    start: { type: 'boolean', description: '是否启动常驻 clangd 并完成 initialize，默认 false' },
  },
  additionalProperties: false,
};

export const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

export async function handler(ctx, rawArgs) {
  const startedAt = Date.now();
  const args = asArgs(rawArgs);
  const start = boolArg(args, 'start', false);

  const config = ctx.config;
  const warnings = [...(ctx.configWarnings || [])];
  const checks = [];

  if (ctx.configError) {
    throw ctx.configError;
  }

  // clangd 二进制
  let clangdPath = null;
  let clangdSource = 'none';
  let exists = false;
  try {
    const resolved = config.clangdPath
      ? { path: config.clangdPath, source: config.clangdPathSource || 'config' }
      : resolveClangdPath(config);
    clangdPath = resolved.path;
    clangdSource = resolved.source;
    exists = Boolean(clangdPath && fs.existsSync(clangdPath));
  } catch (err) {
    warnings.push(String(err && err.message ? err.message : err));
  }
  checks.push({ id: 'clangd.binary', ok: exists, detail: exists ? clangdPath : '未找到 clangd 可执行文件' });

  let version = { version: 'unknown', major: null, raw: '', path: clangdPath };
  if (exists) {
    version = await ctx.client.probeVersion();
    const majorOk = version.major === null || version.major >= 16;
    checks.push({
      id: 'clangd.version',
      ok: majorOk,
      detail: version.major === null ? `无法解析版本（${version.raw || '无输出'}）` : `${version.version}（major=${version.major}）`,
    });
    if (version.major === null) warnings.push('clangd --version 输出无法解析，health 按 unknown 处理。');
    if (version.major !== null && version.major < 16) warnings.push('clangd 版本低于 16，桥不保证可用。');
  } else {
    checks.push({ id: 'clangd.version', ok: false, detail: '跳过（二进制不存在）' });
    warnings.push('找不到 clangd；数据工具会返回 CLANGD_NOT_FOUND。');
  }

  // projectRoot
  const projectRoot = config.projectRoot || null;
  const projectRootExists = Boolean(projectRoot && fs.existsSync(projectRoot));
  checks.push({
    id: 'project.root',
    ok: projectRootExists,
    detail: projectRoot || '未配置 projectRoot',
  });
  if (!projectRoot) warnings.push('未配置 projectRoot；数据工具会返回 PROJECT_NOT_CONFIGURED。');

  // compile_commands.json
  const compileStatus = inspectCompileDb(config.compileCommandsDir);
  checks.push({ id: 'compile_commands.exists', ok: compileStatus.exists, detail: compileStatus.exists ? `${compileStatus.path}` : '文件不存在' });
  if (compileStatus.exists) {
    checks.push({ id: 'compile_commands.parse', ok: compileStatus.valid, detail: compileStatus.valid ? `${compileStatus.entries} entries` : String(compileStatus.error) });
    if (compileStatus.valid) {
      checks.push({
        id: 'compile_commands.compiler',
        ok: true,
        detail: `${compileStatus.compilerKind}${compileStatus.firstCompiler ? `（${path.basename(compileStatus.firstCompiler)}）` : ''}`,
      });
    }
  }

  if (!compileStatus.exists) {
    warnings.push('compile_commands.json 不存在；requireCompileDb=true 时数据工具会直接报错，不会启动 clangd。');
  } else if (!compileStatus.valid) {
    warnings.push(`compile_commands.json 非法：${compileStatus.error}`);
  } else if (isMsvcDb(compileStatus)) {
    warnings.push('compile_commands 使用 MSVC cl.exe；clangd 可能需要额外配置系统头/查询驱动，否则会出现找不到标准库头的假诊断。');
  }

  const ready = Boolean(
    exists
    && projectRootExists
    && (compileStatus.valid || !config.requireCompileDb)
    && (version.major === null || version.major >= 16),
  );

  // 日志目录：必须位于 projectRoot（workspace）或系统临时目录内（规格 10.1）。
  const logDir = config.log && config.log.dir ? config.log.dir : null;
  if (logDir) {
    const logReal = realpathLoose(logDir);
    const tmpReal = realpathLoose(os.tmpdir());
    const projectReal = projectRoot ? realpathLoose(projectRoot) : null;
    const logOk = Boolean(logReal && ((tmpReal && isInsideRoot(logReal, tmpReal)) || (projectReal && isInsideRoot(logReal, projectReal))));
    checks.push({ id: 'log.dir', ok: logOk, detail: logOk ? logDir : `${logDir}（不在 projectRoot 或系统临时目录内）` });
    if (!logOk) warnings.push(`log.dir 不在 projectRoot 或系统临时目录内：${logDir}，日志可能写入任意可写目录。`);
  } else {
    checks.push({ id: 'log.dir', ok: true, detail: '未启用文件日志' });
  }

  // queryDriver：高风险能力，路径必须锁在 allowedRoots 内，启用时必须给出警告（规格 10.3）。
  const queryDriverRequested = config.queryDriverRequested || (config.queryDriverIssue ? config.queryDriver : null);
  const queryDriverActive = Boolean(config.queryDriver);
  if (queryDriverActive) {
    checks.push({ id: 'queryDriver', ok: true, detail: `已启用：${config.queryDriver}` });
    warnings.push(`queryDriver 已启用（${config.queryDriver}）：clangd 会执行匹配的编译器驱动来推断系统头；请确认路径可信且在 allowedRoots 内。`);
  } else if (config.queryDriverIssue) {
    checks.push({ id: 'queryDriver', ok: false, detail: `已禁用：${config.queryDriverIssue}` });
    warnings.push(`queryDriver 已禁用：${config.queryDriverIssue}`);
  } else {
    checks.push({ id: 'queryDriver', ok: true, detail: queryDriverRequested ? `未启用（${queryDriverRequested}）` : '未配置' });
  }

  let processInfo = ctx.client.info;
  if (start) {
    try {
      await ctx.client.ensureStarted();
      processInfo = ctx.client.info;
      checks.push({ id: 'process.start', ok: processInfo.state === 'ready', detail: `pid=${processInfo.pid}` });
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('CLANGD_START_FAILED', 'clangd 启动失败', { error: String(err && err.message) });
    }
  }

  return {
    ok: true,
    bridgeVersion: '0.1.0',
    clangd: {
      path: clangdPath,
      exists,
      version: version.version,
      source: clangdSource,
    },
    project: {
      root: projectRoot,
      compileCommandsDir: config.compileCommandsDir || null,
      compileCommands: {
        exists: compileStatus.exists,
        valid: compileStatus.valid,
        entries: compileStatus.entries,
        compilerKind: compileStatus.compilerKind,
        firstCompiler: compileStatus.firstCompiler,
        fallback: !config.requireCompileDb,
      },
    },
    process: processInfo,
    ready,
    warnings,
    checks,
    meta: metaFor({ client: ctx.client, doc: null, startedAt }),
  };
}
