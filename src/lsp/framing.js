// LSP 基座：Content-Length 分帧。长度按 UTF-8 字节计，不是字符数。
// 解析器要能处理：一个 chunk 多消息、消息跨 chunk、非法 header、缺 Content-Length、超长 body。

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

export class LspFramer {
  constructor({ onMessage, onError, maxBodyBytes = MAX_BODY_BYTES } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onError = onError || (() => {});
    this.maxBodyBytes = maxBodyBytes;
    this.buffer = Buffer.alloc(0);
    this.failed = false;
  }

  fail(error) {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length === 0) return;
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.fail(new Error('LSP header 超过 8KB，疑似分帧损坏'));
        }
        return;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      let contentLength = null;
      let badHeader = null;
      for (const rawLine of headerText.split('\r\n')) {
        if (rawLine === '') continue;
        const sep = rawLine.indexOf(':');
        if (sep === -1) {
          badHeader = `非法 header 行：${rawLine.slice(0, 100)}`;
          break;
        }
        const key = rawLine.slice(0, sep).trim().toLowerCase();
        const value = rawLine.slice(sep + 1).trim();
        if (key === 'content-length') {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0) {
            badHeader = `Content-Length 非法：${value}`;
            break;
          }
          contentLength = n;
        }
      }
      if (badHeader) {
        this.fail(new Error(badHeader));
        return;
      }
      if (contentLength === null) {
        this.fail(new Error('LSP 消息缺少 Content-Length'));
        return;
      }
      if (contentLength > this.maxBodyBytes) {
        this.fail(new Error(`LSP body 超过上限（${contentLength} > ${this.maxBodyBytes}）`));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return; // 等待后续 chunk
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      let message;
      try {
        message = JSON.parse(body);
      } catch (err) {
        this.onError(new Error(`LSP body 不是合法 JSON：${String(err && err.message)}`));
        continue;
      }
      try {
        this.onMessage(message);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
