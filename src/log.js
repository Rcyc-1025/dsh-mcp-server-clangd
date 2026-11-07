// 日志：只写 stderr 与文件，绝不写 stdout（stdout 由 MCP 协议独占）。
// 提供环形缓冲，供 CLANGD_CRASHED / INTERNAL_ERROR 的 details.stderrTail 使用。

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const REDACT_KEYS = /(token|secret|password|passwd|api[-_]?key|authorization)/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = REDACT_KEYS.test(key) ? '***' : redact(item, depth + 1);
  }
  return out;
}

export class Logger {
  constructor({ level = 'info', dir = null, maxBytes = 5 * 1024 * 1024, maxFiles = 3, tailBytes = 64 * 1024 } = {}) {
    this.level = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
    this.levelName = LEVELS[level] === undefined ? 'info' : level;
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.tailBytes = tailBytes;
    this.chunks = [];
    this.tailSize = 0;
    this.logPath = null;
    this.fileError = null;

    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.logPath = path.join(dir, 'clangd-bridge.log');
        this.rotateIfNeeded();
      } catch (err) {
        // 日志目录不可用时退化为仅 stderr，不让启动失败。
        this.fileError = String(err && err.message ? err.message : err);
        this.dir = null;
        this.logPath = null;
      }
    }
  }

  rotateIfNeeded() {
    if (!this.logPath) return;
    try {
      const st = fs.statSync(this.logPath);
      if (st.size <= this.maxBytes) return;
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const from = `${this.logPath}.${i}`;
        const to = `${this.logPath}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i + 1 >= this.maxFiles) fs.rmSync(from, { force: true });
          else fs.renameSync(from, to);
        }
      }
      fs.renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      // 轮转失败不影响主流程
    }
  }

  pushTail(line) {
    this.chunks.push(line);
    this.tailSize += Buffer.byteLength(line, 'utf8');
    while (this.tailSize > this.tailBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.tailSize -= Buffer.byteLength(removed, 'utf8');
    }
  }

  stderrTail() {
    return this.chunks.join('');
  }

  log(level, event, fields = {}) {
    const numeric = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
    const payload = redact(fields || {});
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...payload });
    this.pushTail(line + '\n');
    if (numeric <= this.level) {
      try {
        process.stderr.write(line + '\n');
      } catch {
        // stderr 被关闭时忽略
      }
    }
    if (this.logPath && numeric <= this.level) {
      try {
        this.rotateIfNeeded();
        fs.appendFileSync(this.logPath, line + '\n', 'utf8');
      } catch {
        // 文件日志失败不阻塞
      }
    }
    return line;
  }

  error(event, fields) {
    return this.log('error', event, fields);
  }

  warn(event, fields) {
    return this.log('warn', event, fields);
  }

  info(event, fields) {
    return this.log('info', event, fields);
  }

  debug(event, fields) {
    return this.log('debug', event, fields);
  }
}

export function createLogger(config) {
  const log = (config && config.log) || {};
  return new Logger({
    level: log.level || 'info',
    dir: log.dir || null,
    maxBytes: log.maxBytes || 5 * 1024 * 1024,
    maxFiles: log.maxFiles || 3,
  });
}
