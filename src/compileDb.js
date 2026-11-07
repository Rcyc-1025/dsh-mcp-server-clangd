// compile_commands.json 检查：存在性、JSON 合法性、条目字段、编译器类型。
// 不生成、不改写 compile db；也不把 MSVC 命令翻译成 clang 命令。

import fs from 'node:fs';
import path from 'node:path';

function firstToken(command) {
  const text = String(command || '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end === -1 ? text : text.slice(1, end);
  }
  const match = text.match(/^\S+/);
  return match ? match[0] : '';
}

export function detectCompilerKind(entry) {
  let exe = '';
  if (entry && Array.isArray(entry.arguments) && entry.arguments.length > 0) {
    exe = String(entry.arguments[0] || '');
  } else if (entry && typeof entry.command === 'string') {
    exe = firstToken(entry.command);
  }
  if (!exe) return { kind: 'unknown', firstCompiler: null };
  const base = path.basename(String(exe).replace(/^"|"$/g, '')).toLowerCase();
  let kind = 'unknown';
  if (base === 'cl.exe' || base === 'cl') kind = 'msvc';
  else if (base.startsWith('clang-cl')) kind = 'msvc';
  else if (base.startsWith('clang')) kind = 'clang';
  else if (/^(gcc|g\+\+|cc|c\+\+)(\.exe)?$/.test(base)) kind = 'gcc';
  return { kind, firstCompiler: String(exe) };
}

function validateEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `#${index}: 条目不是对象`;
  if (typeof entry.directory !== 'string' || entry.directory.trim() === '') return `#${index}: 缺少 directory`;
  if (typeof entry.file !== 'string' || entry.file.trim() === '') return `#${index}: 缺少 file`;
  const hasCommand = typeof entry.command === 'string' && entry.command.trim() !== '';
  const hasArgs = Array.isArray(entry.arguments) && entry.arguments.length > 0 && entry.arguments.every((a) => typeof a === 'string');
  if (!hasCommand && !hasArgs) return `#${index}: 需要 command 或 arguments`;
  return null;
}

// 返回结构化状态，不抛异常（health 需要报告而不是失败）。
export function inspectCompileDb(dir) {
  const result = {
    dir: dir || null,
    path: dir ? path.join(dir, 'compile_commands.json') : null,
    exists: false,
    valid: false,
    entries: 0,
    compilerKind: 'unknown',
    firstCompiler: null,
    error: null,
    invalidEntries: [],
  };
  if (!dir) {
    result.error = 'compileCommandsDir 未配置';
    return result;
  }
  if (!fs.existsSync(result.path)) {
    result.error = '文件不存在';
    return result;
  }
  result.exists = true;
  let text;
  try {
    text = fs.readFileSync(result.path, 'utf8');
  } catch (err) {
    result.error = `读取失败：${String(err && err.message)}`;
    return result;
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    result.error = `JSON 解析失败：${String(err && err.message).slice(0, 300)}`;
    return result;
  }
  if (!Array.isArray(data)) {
    result.error = '顶层不是数组';
    return result;
  }
  result.entries = data.length;
  if (data.length === 0) {
    result.error = '数组为空';
    return result;
  }
  const bad = [];
  for (let i = 0; i < data.length; i += 1) {
    const problem = validateEntry(data[i], i);
    if (problem) bad.push(problem);
    if (bad.length >= 3) break;
  }
  if (bad.length > 0) {
    result.invalidEntries = bad;
    result.error = `条目缺少必需字段：${bad.join('；')}`;
    return result;
  }
  const detected = detectCompilerKind(data[0]);
  result.compilerKind = detected.kind;
  result.firstCompiler = detected.firstCompiler;
  result.valid = true;
  return result;
}

export function isMsvcDb(status) {
  return Boolean(status && status.valid && status.compilerKind === 'msvc');
}
