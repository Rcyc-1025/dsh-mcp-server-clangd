// clangd_definition：textDocument/definition（含 LocationLink 的 targetSelectionRange）。

import { normalizeDefinition } from '../lsp/normalize.js';
import { asArgs, intArg, metaFor, prepareFile, stringArg } from './common.js';

export const name = 'clangd_definition';

export const description =
  '查询某个位置符号的定义（textDocument/definition）。输入 file（绝对路径或相对 projectRoot）、1-based line/column；返回定义所在文件与选区范围（1-based，end exclusive）。';

export const inputSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: '源文件路径：绝对路径，或相对 projectRoot 的路径' },
    line: { type: 'integer', minimum: 1, description: '1-based 行号' },
    column: { type: 'integer', minimum: 1, description: '1-based 列号（UTF-16）' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条定义，默认 maxResults' },
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
  const limit = intArg(args, 'limit', { min: 1, max: ctx.config.maxResults, fallback: ctx.config.maxResults });

  const { doc, lspPosition } = await prepareFile(ctx, file, { position: { line, column } });

  const result = await ctx.client.request(
    'textDocument/definition',
    { textDocument: { uri: doc.uri }, position: lspPosition },
    ctx.config.requestTimeoutMs,
  );

  const all = normalizeDefinition(result);
  const locations = all.slice(0, limit);
  const truncated = all.length > locations.length;

  const out = {
    ok: true,
    file: doc.path.split('\\').join('/'),
    position: { line, column },
    locations,
    total: all.length,
    meta: metaFor({ client: ctx.client, doc, startedAt, truncated }),
  };
  if (all.length === 0) {
    out.note = 'clangd 未返回定义：可能指向宏、声明即定义、生成代码，或索引尚未完成；可先调用 clangd_health 检查 readiness。';
  }
  return out;
}
