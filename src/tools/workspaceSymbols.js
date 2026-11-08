// clangd_workspace_symbols：workspace/symbol（模糊匹配，空 query 明确报错而不是拉全量）。

import { BridgeError, invalidArgument } from '../errors.js';
import { normalizeWorkspaceSymbols } from '../lsp/normalize.js';
import { asArgs, ensureConfigured, intArg, metaFor } from './common.js';

export const name = 'clangd_workspace_symbols';

export const description =
  '在工作区内按名称模糊搜索符号（workspace/symbol）。query 必填且不能为空（避免返回全量索引）；结果按 clangd 相关性顺序，超过 limit 截断。';

export const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 128, description: '符号名或片段（模糊匹配），1..128 字符' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 50' },
  },
  required: ['query'],
  additionalProperties: false,
};

export const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

export async function handler(ctx, rawArgs) {
  const startedAt = Date.now();
  const args = asArgs(rawArgs);

  if (args.query === undefined || args.query === null) {
    throw invalidArgument('缺少必填参数 query');
  }
  if (typeof args.query !== 'string') throw invalidArgument('query 必须是字符串', { field: 'query' });
  const query = args.query.trim();
  if (query === '') {
    throw invalidArgument('query 不能为空：空查询会返回整个索引，桥不允许', { field: 'query' });
  }
  const maxQuery = ctx.config.maxWorkspaceQueryLength || 128;
  if (query.length > maxQuery) {
    throw new BridgeError('QUERY_TOO_LONG', `query 超过长度上限 ${maxQuery}`, { field: 'query', length: query.length, maxQuery });
  }

  const limit = intArg(args, 'limit', { min: 1, max: 200, fallback: 50 });

  if (!ctx.config.projectRoot) {
    ensureConfigured(ctx);
  }
  ctx.client.assertCompileDb();
  await ctx.client.ensureStarted();

  const result = await ctx.client.request(
    'workspace/symbol',
    { query },
    ctx.config.requestTimeoutMs,
  );

  const normalized = normalizeWorkspaceSymbols(result, limit);
  const out = {
    ok: true,
    query,
    symbols: normalized.symbols,
    total: normalized.total,
    truncated: normalized.truncated,
    meta: metaFor({ client: ctx.client, doc: null, startedAt, truncated: normalized.truncated }),
  };
  if (normalized.total === 0) {
    out.note = '没有匹配符号：可能是索引尚未完成（background-index 仍在跑），或名称拼写不同。';
  }
  return out;
}
