// 路径、URI、位置换算与 allowedRoots 安全边界。
// 关键点：realpath 之后再做「分隔符边界」前缀比较，避免 C:/root2 被当成 C:/root 的子路径。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BridgeError, invalidArgument } from './errors.js';

export const SUPPORTED_EXTS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.c++',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.h++',
  '.inl',
  '.ipp',
  '.m',
  '.mm',
]);

const LANG_BY_EXT = {
  '.c': 'c',
  '.h': 'c',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',
};

export function languageIdFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.c' || ext === '.h') return LANG_BY_EXT[ext];
  if (ext === '.m') return 'objective-c';
  if (ext === '.mm') return 'objective-cpp';
  return 'cpp';
}

export function assertSupportedLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new BridgeError('UNSUPPORTED_LANGUAGE', `不支持的扩展名：${ext || '(无扩展名)'}`, { file: filePath, ext });
  }
}

export function isDeviceOrUncPath(input) {
  if (!input) return false;
  const s = String(input);
  return /^[\\/]{2}/.test(s) || /^\/\/[?.]\/?/.test(s);
}

export function realpathOrNull(input) {
  try {
    return fs.realpathSync.native(input);
  } catch {
    return null;
  }
}

export function normalizeKey(input) {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 判断 child 是否等于 root 或位于 root 之下（realpath 之后调用）。
export function isInsideRoot(child, root) {
  const c = normalizeKey(child);
  const r = normalizeKey(root);
  const rel = path.relative(r, c);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

// 解析可能尚不存在的路径：对最近存在的祖先做 realpath，再拼回剩余段。
// 用于校验 log.dir / queryDriver 这类“即将创建或带通配符”的路径。
export function realpathLoose(input) {
  let current = path.resolve(input);
  const tail = [];
  for (let depth = 0; depth < 64; depth += 1) {
    const real = realpathOrNull(current);
    if (real) return tail.length ? path.join(real, ...[...tail].reverse()) : real;
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.push(path.basename(current));
    current = parent;
  }
  return null;
}

// 展开配置里的 %VAR%（Windows 风格）；未知变量原样保留。
export function expandEnvVars(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    const upper = name.toUpperCase();
    const found = env[upper] ?? env[name];
    return found === undefined ? whole : found;
  });
}

const GLOB_CHARS = /[*?\[]/;

// 校验 queryDriver（'=' 后用分号分隔的 glob 列表）：
// 每个条目必须是绝对路径，且其静态部分所在目录（realpath 后）位于 allowedRoots 内。
// 返回 null 表示通过；否则返回中文原因。不做“信任用户”的假设：这是执行外部编译器的入口。
export function queryDriverProblem(value, allowedRoots, env = process.env) {
  if (!value) return null;
  const entries = String(value).split(';').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return 'queryDriver 为空';
  for (const rawEntry of entries) {
    const entry = expandEnvVars(rawEntry, env);
    if (isDeviceOrUncPath(entry)) return `条目是设备/UNC 路径：${entry}`;
    if (!path.isAbsolute(entry)) return `条目必须是绝对路径：${entry}`;
    const globAt = entry.search(GLOB_CHARS);
    const staticPart = globAt === -1 ? entry : entry.slice(0, globAt);
    if (!staticPart) return `条目必须以绝对路径开头：${entry}`;
    let anchor = staticPart;
    if (globAt !== -1 && !/[\\/]$/.test(staticPart)) anchor = path.dirname(staticPart);
    const realAnchor = realpathLoose(anchor);
    if (!realAnchor) return `路径不存在：${anchor}`;
    if (!(allowedRoots || []).some((root) => isInsideRoot(realAnchor, root))) {
      return `路径不在 allowedRoots 内：${realAnchor}`;
    }
  }
  return null;
}

export function assertInsideAllowedRoots(realPath, allowedRoots, extra = {}) {
  for (const root of allowedRoots || []) {
    if (isInsideRoot(realPath, root)) return root;
  }
  throw new BridgeError(
    'PATH_OUTSIDE_ALLOWED_ROOTS',
    '路径不在 allowedRoots 允许范围内',
    { resolvedPath: realPath, allowedRoots: (allowedRoots || []).slice(), ...extra },
  );
}

// 解析工具入参里的 file：绝对路径或相对 projectRoot；随后做存在性、大小、允许根校验。
export function resolveInputFile(config, fileArg, { maxFileBytes = Infinity } = {}) {
  if (typeof fileArg !== 'string' || fileArg.trim() === '') {
    throw invalidArgument('file 必须是非空字符串');
  }
  const raw = fileArg.trim();
  if (isDeviceOrUncPath(raw)) {
    throw new BridgeError('PATH_OUTSIDE_ALLOWED_ROOTS', '拒绝设备路径 / UNC 路径', { file: raw });
  }
  const base = config.projectRoot || process.cwd();
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);

  if (!fs.existsSync(abs)) {
    throw new BridgeError('FILE_NOT_FOUND', '文件不存在或不可读', { file: abs });
  }
  const real = realpathOrNull(abs);
  if (!real) {
    throw new BridgeError('FILE_NOT_FOUND', '文件不存在或不可读', { file: abs });
  }
  assertInsideAllowedRoots(real, config.allowedRoots, { input: raw });

  let stat;
  try {
    stat = fs.statSync(real);
  } catch (err) {
    throw new BridgeError('FILE_NOT_FOUND', '文件无法读取', { file: real, cause: String(err && err.message) });
  }
  if (!stat.isFile()) {
    throw new BridgeError('FILE_NOT_FOUND', '目标不是普通文件', { file: real });
  }
  if (maxFileBytes !== Infinity && stat.size > maxFileBytes) {
    throw new BridgeError('FILE_TOO_LARGE', '文件超过 maxFileBytes 限制', {
      file: real,
      size: stat.size,
      maxFileBytes,
    });
  }
  assertSupportedLanguage(real);
  return { path: real, uri: pathToFileURL(real).href, stat };
}

export function toUri(filePath) {
  return pathToFileURL(filePath).href;
}

export function fromUri(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// 把文件文本按 LSP 的行规则切分：\r\n、\r、\n 都算换行，行尾不带 \r。
export function splitLines(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

// 1-based（UTF-16 列）→ LSP 0-based；越界报 POSITION_OUT_OF_RANGE，不静默 clamp。
export function toLspPosition(content, line, column) {
  if (!Number.isInteger(line)) throw invalidArgument('line 必须是整数（1-based）');
  if (!Number.isInteger(column)) throw invalidArgument('column 必须是整数（1-based）');
  if (line < 1 || column < 1) {
    throw new BridgeError('POSITION_OUT_OF_RANGE', 'line/column 必须从 1 开始', { line, column });
  }
  const lines = splitLines(content);
  if (line > lines.length) {
    throw new BridgeError('POSITION_OUT_OF_RANGE', 'line 超过文件行数', { line, lines: lines.length });
  }
  const lineText = lines[line - 1];
  const maxColumn = lineText.length + 1; // 允许停在行尾
  if (column > maxColumn) {
    throw new BridgeError('POSITION_OUT_OF_RANGE', 'column 超过该行 UTF-16 长度', {
      line,
      column,
      lineUtf16Length: lineText.length,
    });
  }
  return { line: line - 1, character: column - 1 };
}

// LSP 0-based → 1-based（输出统一 1-based）。
export function fromLspPosition(position) {
  if (!position || typeof position.line !== 'number') return null;
  return { line: position.line + 1, column: (position.character ?? 0) + 1 };
}

export function fromLspRange(range) {
  if (!range || !range.start || !range.end) return null;
  return { start: fromLspPosition(range.start), end: fromLspPosition(range.end) };
}

// 把工具输出里的绝对路径统一成正斜杠，便于 agent 直接复用。
export function displayPath(filePath) {
  return String(filePath).split(path.sep).join('/');
}
