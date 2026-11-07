// clangd_hover：textDocument/hover。

import { normalizeHover } from '../lsp/normalize.js';
import { asArgs, intArg, metaFor, prepareFile, stringArg } from './common.js';

export const name = 'clangd_hover';

export const description =
  '查询某个位置符号的悬停信息（textDocument/hover）：类型、声明、注释。输入 1-based line/column，返回 contents 文本及其 markdown/plaintext 类型。';

export const inputSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: '源文件路径：绝对路径，或相对 projectRoot 的路径' },
    line: { type: 'integer', minimum: 1, description: '1-based 行号' },
    column: { type: 'integer', minimum: 1, description: '1-based 列号（UTF-16）' },
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

  const { doc, lspPosition } = await prepareFile(ctx, file, { position: { line, column } });

  const result = await ctx.client.request(
    'textDocument/hover',
    { textDocument: { uri: doc.uri }, position: lspPosition },
    ctx.config.requestTimeoutMs,
  );

  const hover = normalizeHover(result);
  const out = {
    ok: true,
    file: doc.path.split('\\').join('/'),
    position: { line, column },
    contents: hover.contents,
    kind: hover.kind,
    range: hover.range,
    empty: hover.empty,
    meta: metaFor({ client: ctx.client, doc, startedAt }),
  };
  if (hover.empty) {
    out.note = 'clangd 在该位置没有悬停信息（可能是空白、注释或未被索引的符号）。';
  }
  return out;
}
