// 生成 fixtures 的 compile_commands.json（模板里的 {{CLANGXX}} / {{FIXTURE_DIR}} 占位）。
// 目的：仓库里不留本机 clang++ 与目录的绝对路径，clone 后按本机环境重新生成。
// 编译器解析顺序：CLANGXX 环境变量 > clangd-bridge.json 里 clangd 同目录的 clang++ > PATH 里的 clang++。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './client.mjs';

const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const CASES = ['hello', 'broken'];
const CONFIG = path.join(ROOT, 'clangd-bridge.json');

function siblingCompiler(clangdPath) {
  if (!clangdPath) return null;
  const exe = process.platform === 'win32' ? 'clang++.exe' : 'clang++';
  const candidate = path.join(path.dirname(clangdPath), exe);
  return fs.existsSync(candidate) ? candidate : null;
}

export function resolveCompiler() {
  if (process.env.CLANGXX && fs.existsSync(process.env.CLANGXX)) return process.env.CLANGXX;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const found = siblingCompiler(cfg.clangdPath);
    if (found) return found;
  } catch {
    // 没有本地配置就退回 PATH
  }
  return 'clang++';
}

export function ensureFixtures({ cases = CASES, compiler = resolveCompiler() } = {}) {
  const written = [];
  for (const name of cases) {
    const dir = path.join(FIXTURES, name);
    const template = path.join(dir, 'compile_commands.template.json');
    if (!fs.existsSync(template)) continue;
    const text = fs
      .readFileSync(template, 'utf8')
      .replaceAll('{{CLANGXX}}', compiler.split('\\').join('/'))
      .replaceAll('{{FIXTURE_DIR}}', dir.split('\\').join('/'));
    const dest = path.join(dir, 'compile_commands.json');
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== text) fs.writeFileSync(dest, text);
    written.push(dest);
  }
  return written;
}
