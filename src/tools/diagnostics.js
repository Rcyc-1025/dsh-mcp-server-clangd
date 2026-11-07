// clangd_diagnostics：didOpen/didChange 后等 publishDiagnostics（push 模型），超时标 pending。

import { invalidArgument } from '../errors.js';
import { isMsvcDb } from '../compileDb.js';
import { normalizeDiagnostic } from '../lsp/normalize.js';
import { asArgs, boolArg, intArg, metaFor, prepareFile, stringArg } from './common.js';

export const name = 'clangd_diagnostics';

export const description =
  '获取某个文件的 clangd 诊断（错误/警告/提示）。会先 didOpen/didChange 再等待 publishDiagnostics 推送；waitMs 超时则返回 pending=true 与已缓存的诊断。';

export const inputSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: '源文件路径：绝对路径，或相对 projectRoot 的路径' },
    severity: {
      type: 'string',
      enum: ['error', 'warning', 'information', 'hint'],
      description: '只返回某一严重级别；缺省返回全部',
    },
    includeRelated: { type: 'boolean', description: '是否包含 relatedInformation，默认 false' },
    waitMs: { type: 'integer', minimum: 0, maximum: 10000, description: '等待诊断的最长时间，默认 diagnosticsWaitMs' },
  },
  required: ['file'],
  additionalProperties: false,
};

export const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: false };

const SEVERITIES = new Set(['error', 'warning', 'information', 'hint']);

export async function handler(ctx, rawArgs) {
  const startedAt = Date.now();
  const args = asArgs(rawArgs);
  const file = stringArg(args, 'file', { required: true });
  const includeRelated = boolArg(args, 'includeRelated', false);
  const waitMs = intArg(args, 'waitMs', { min: 0, max: 10000, fallback: ctx.config.diagnosticsWaitMs });
  const severity = stringArg(args, 'severity', { required: false });
  if (severity !== undefined && !SEVERITIES.has(severity)) {
    throw invalidArgument('severity 只能是 error/warning/information/hint', { severity });
  }

  const { doc } = await prepareFile(ctx, file);

  const waitStartedAt = Date.now();
  const entry = await ctx.client.waitForDiagnostics(doc.uri, doc.version, waitMs);
  const waitedMs = Date.now() - waitStartedAt;
  const pending = entry === null;

  const rawList = entry ? entry.diagnostics : [];
  const normalized = rawList.map((d) => normalizeDiagnostic(d, { includeRelated }));
  const filtered = severity ? normalized.filter((d) => d.severity === severity) : normalized;

  const limit = ctx.config.maxResults;
  const diagnostics = filtered.slice(0, limit);
  const truncated = filtered.length > diagnostics.length;

  const out = {
    ok: true,
    file: doc.path.split('\\').join('/'),
    uri: doc.uri,
    version: doc.version,
    diagnostics,
    total: filtered.length,
    pending,
    waitedMs,
    meta: metaFor({ client: ctx.client, doc, startedAt, truncated }),
  };
  if (pending) {
    out.note = `等待 ${waitMs}ms 内没有收到与 version=${doc.version} 匹配的 publishDiagnostics；返回的是当前缓存（可能为空）。可增大 waitMs 后重试。`;
  }

  // MSVC compile_commands 的已知噪声：用 meta.warnings 提示，而不是失败。
  const db = ctx.client.compileDbStatus();
  if (db && db.valid && isMsvcDb(db)) {
    out.meta.warnings = [
      'compile_commands.compiler=msvc：clangd 使用 MSVC 命令行时，系统头/标准库相关诊断可能是假阳性。',
    ];
  }
  return out;
}
