// 文档同步：首次 didOpen，内容变化 didChange（全量文本），LRU 淘汰 didClose。
// 不做文件系统 watcher；每次请求用 stat(mtime+size) 检查，必要时再算 SHA-256。

import crypto from 'node:crypto';
import fs from 'node:fs';
import { BridgeError } from '../errors.js';
import { languageIdFor } from '../paths.js';

export class DocumentStore {
  constructor({ config, client, logger }) {
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.docs = new Map();
    this.order = [];
    this.locks = new Map();
    // clangd 崩溃/重启后，旧进程打开的文档全部失效：清空记录，下一次 ensure 会重新 didOpen。
    if (this.client && typeof this.client.on === 'function') {
      this.client.on('exit', () => this.forgetAll());
    }
  }

  // 只丢弃本地记录，不发送 didClose（进程已经退出）；版本从 1 重新开始。
  forgetAll() {
    const count = this.docs.size;
    this.docs.clear();
    this.order = [];
    if (count > 0) this.logger.debug('document.forget-all', { count });
  }

  clearDiagnostics(uri) {
    if (this.client && typeof this.client.clearDiagnostics === 'function') this.client.clearDiagnostics(uri);
  }

  static key(filePath) {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
  }

  get size() {
    return this.docs.size;
  }

  get(filePath) {
    return this.docs.get(DocumentStore.key(filePath)) || null;
  }

  touch(key) {
    const idx = this.order.indexOf(key);
    if (idx !== -1) this.order.splice(idx, 1);
    this.order.push(key);
  }

  withLock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      key,
      next.finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      }),
    );
    return next;
  }

  async evictOldest() {
    while (this.order.length > 0) {
      const key = this.order[0];
      const doc = this.docs.get(key);
      this.order.shift();
      if (!doc) continue;
      try {
        this.client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
      } catch (err) {
        this.logger.warn('document.close-failed', { uri: doc.uri, error: String(err && err.message) });
      }
      this.clearDiagnostics(doc.uri);
      this.docs.delete(key);
      this.logger.debug('document.evicted', { uri: doc.uri });
      return;
    }
  }

  async ensure(filePath, uri) {
    const key = DocumentStore.key(filePath);
    return this.withLock(key, async () => {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        throw new BridgeError('FILE_NOT_FOUND', '文件不存在或不可读', { file: filePath });
      }

      const existing = this.docs.get(key);
      if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size && existing.opened) {
        this.touch(key);
        return existing;
      }

      if (stat.size > this.config.maxFileBytes) {
        throw new BridgeError('FILE_TOO_LARGE', '文件超过 maxFileBytes 限制', {
          file: filePath,
          size: stat.size,
          maxFileBytes: this.config.maxFileBytes,
        });
      }

      let buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch {
        throw new BridgeError('FILE_NOT_FOUND', '文件无法读取', { file: filePath });
      }
      const text = buffer.toString('utf8'); // 保留原样（含 BOM），与磁盘一致
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      if (!existing) {
        if (this.docs.size >= this.config.maxOpenDocuments) await this.evictOldest();
        const doc = {
          key,
          path: filePath,
          uri,
          version: 1,
          hash,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          content: text,
          opened: true,
        };
        // 首次打开：该 URI 之前（可能来自旧进程/旧版本）的缓存诊断一律作废；
        // 先清再 didOpen，避免 clangd 立即推送的诊断被误删。
        this.clearDiagnostics(uri);
        this.client.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: languageIdFor(filePath), version: 1, text },
        });
        this.docs.set(key, doc);
        this.touch(key);
        this.logger.debug('document.open', { uri, size: stat.size, openDocs: this.docs.size });
        return doc;
      }

      if (existing.hash === hash) {
        existing.mtimeMs = stat.mtimeMs;
        existing.size = stat.size;
        this.touch(key);
        return existing;
      }

      existing.version += 1;
      existing.hash = hash;
      existing.mtimeMs = stat.mtimeMs;
      existing.size = stat.size;
      existing.content = text;
      // 内容已变：先清空旧诊断，再 didChange 等新版本的 publishDiagnostics。
      this.clearDiagnostics(uri);
      this.client.notify('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
      this.touch(key);
      this.logger.debug('document.change', { uri, version: existing.version, size: stat.size });
      return existing;
    });
  }

  versionOf(filePath) {
    const doc = this.get(filePath);
    return doc ? doc.version : null;
  }

  async closeAll() {
    for (const key of [...this.order]) {
      const doc = this.docs.get(key);
      if (!doc) continue;
      try {
        this.client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
      } catch {
        // 进程可能已退出
      }
      this.clearDiagnostics(doc.uri);
      this.docs.delete(key);
    }
    this.order = [];
  }
}
