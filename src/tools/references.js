// clangd_references：textDocument/references。

import { normalizeReferences } from '../lsp/normalize.js';
import { asArgs, boolArg, intArg, metaFor, prepareFile, stringArg } from './common.js';

export const name = 'clangd_references';

export const description =
  '查找符号的全部引用（textDocument/references）。返回按文件/行/列排序的 1-based 位置列表；includeDeclaration 控制是否包含声明本身。';

export const inputSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: '源文件路径：绝对路径，或相对 projectRoot 的路径' },
    line: { type: 'integer', minimum: 1, description: '1-based 行号' },
    column: { type: 'integer', minimum: 1, description: '1-based 列号（UTF-16）' },
    includeDeclaration: { type: 'boolean', description: '是否包含声明位置，默认 true' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条引用，默认 maxResults' },
  },
  required: ['file', 'line', 'column'],
  additionalProperties: false,
};

export const annotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

export async function handler(ctx, rawArgs) {
  const startedAt = Date.now();
  const args = asArgs(rawArgs);
  const file = stringArg(args, 'file', { required: true });
  const line = intArg(args, 'line', { required: true, min: 1 });
  const column = intArg(args, 'column', { required: true, min: 1 });
  const includeDeclaration = boolArg(args, 'includeDeclaration', true);
  const limit = intArg(args, 'limit', { min: 1, max: ctx.config.maxResults, fallback: ctx.config.maxResults });

  const { doc, lspPosition } = await prepareFile(ctx, file, { position: { line, column } });

  const result = await ctx.client.request(
    'textDocument/references',
    {
      textDocument: { uri: doc.uri },
      position: lspPosition,
      context: { includeDeclaration },
    },
    ctx.config.requestTimeoutMs,
  );

  const all = normalizeReferences(result);
  const references = all.slice(0, limit);
  const truncated = all.length > references.length;

  const out = {
    ok: true,
    file: doc.path.split('\\').join('/'),
    position: { line, column },
    includeDeclaration,
    references,
    total: all.length,
    meta: metaFor({ client: ctx.client, doc, startedAt, truncated }),
  };
  if (all.length === 0) {
    out.note = 'clangd 未返回引用：可能该符号未被索引、只在当前文件内使用但索引未完成，或 includeDeclaration=false 且仅剩声明。';
  }
  return out;
}
