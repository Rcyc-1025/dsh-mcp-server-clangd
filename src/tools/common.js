// 工具公共件：参数校验、前置检查、统一信封。业务错误一律 BridgeError。

import { BridgeError, invalidArgument } from '../errors.js';
import { resolveInputFile, toLspPosition } from '../paths.js';

export function asArgs(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalidArgument('tools/call 的 arguments 必须是对象');
  return raw;
}

export function stringArg(args, name, { required = false, maxLength = Infinity } = {}) {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw invalidArgument(`缺少必填参数 ${name}`);
    return undefined;
  }
  if (typeof value !== 'string') throw invalidArgument(`${name} 必须是字符串`, { field: name });
  const trimmed = value.trim();
  if (trimmed === '' && required) throw invalidArgument(`${name} 不能为空`, { field: name });
  if (trimmed.length > maxLength) throw new BridgeError('QUERY_TOO_LONG', `${name} 超过长度上限`, { field: name, length: trimmed.length, maxLength });
  return trimmed;
}

export function intArg(args, name, { required = false, min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const raw = args[name];
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback;
    if (required) throw invalidArgument(`缺少必填参数 ${name}`);
    return undefined;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value)) throw invalidArgument(`${name} 必须是整数`, { field: name });
  if (value < min || value > max) {
    if (name === 'limit') throw new BridgeError('LIMIT_OUT_OF_RANGE', `limit 必须在 ${min}..${max} 之间`, { limit: value, min, max });
    throw invalidArgument(`${name} 必须在 ${min}..${max} 之间`, { field: name, value, min, max });
  }
  return value;
}

export function boolArg(args, name, fallback) {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw invalidArgument(`${name} 必须是布尔值`, { field: name });
  return value;
}

export function ensureConfigured(ctx) {
  if (ctx.configError) throw ctx.configError;
  if (!ctx.config.projectRoot) {
    throw new BridgeError('PROJECT_NOT_CONFIGURED', '缺少 projectRoot 配置', {
      configPath: ctx.configPath || null,
    });
  }
}

// 解析文件 → 校验 compile db（不 spawn）→ 启动/复用 clangd → didOpen/didChange。
export async function prepareFile(ctx, fileArg, { position = null } = {}) {
  ensureConfigured(ctx);
  const target = resolveInputFile(ctx.config, fileArg, { maxFileBytes: ctx.config.maxFileBytes });
  ctx.client.assertCompileDb();
  await ctx.client.ensureStarted();
  const doc = await ctx.documents.ensure(target.path, target.uri);
  let lspPosition = null;
  if (position) {
    lspPosition = toLspPosition(doc.content, position.line, position.column);
  }
  return { target, doc, lspPosition };
}

export function metaFor({ client, doc, startedAt, truncated = false, extra = {} }) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const meta = {
    elapsedMs,
    clangdPid: client ? client.pid : null,
    documentVersion: doc ? doc.version : null,
    truncated: Boolean(truncated),
    ...extra,
  };
  if (elapsedMs > 5000) meta.slow = true;
  return meta;
}

export function truncateList(list, limit) {
  const items = Array.isArray(list) ? list : [];
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  };
}
