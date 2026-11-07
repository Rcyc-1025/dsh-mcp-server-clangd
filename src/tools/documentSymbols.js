// clangd_document_symbols：textDocument/documentSymbol（层次树优先，DFS 预算裁剪）。

import { normalizeDocumentSymbols } from '../lsp/normalize.js';
import { asArgs, intArg, metaFor, prepareFile, stringArg } from './common.js';

export const name = 'clangd_document_symbols';

export const description =
  '获取单个文件内的符号大纲（textDocument/documentSymbol）。clangd 返回层次结构时保留父子关系；超过 limit 时按 DFS 截断并标记 truncated。';

export const inputSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: '源文件路径：绝对路径，或相对 projectRoot 的路径' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少个符号节点（含子节点），默认 maxResults' },
  },
  required: ['file'],
  additionalProperties: false,
};

export const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

export async function handler(ctx, rawArgs) {
  const startedAt = Date.now();
  const args = asArgs(rawArgs);
  const file = stringArg(args, 'file', { required: true });
  const limit = intArg(args, 'limit', { min: 1, max: ctx.config.maxResults, fallback: ctx.config.maxResults });

  const { doc } = await prepareFile(ctx, file);

  const result = await ctx.client.request(
    'textDocument/documentSymbol',
    { textDocument: { uri: doc.uri } },
    ctx.config.requestTimeoutMs,
  );

  const normalized = normalizeDocumentSymbols(result, limit);
  const out = {
    ok: true,
    file: doc.path.split('\\').join('/'),
    uri: doc.uri,
    hierarchical: normalized.hierarchical,
    symbols: normalized.symbols,
    total: normalized.total,
    meta: metaFor({ client: ctx.client, doc, startedAt, truncated: normalized.truncated }),
  };
  if (normalized.truncated) out.note = `符号数 ${normalized.total} 超过 limit=${limit}，已按 DFS 顺序截断，树可能不完整。`;
  if (normalized.total === 0) out.note = 'clangd 未返回符号：文件可能是空的、全是宏，或尚未被索引。';
  return out;
}
