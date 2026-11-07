// 测试/验收共用的 MCP stdio 客户端：一行一个 JSON-RPC 消息，按 id 配对。

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class McpClient {
  constructor({ configPath, serverPath = path.join(ROOT, 'src', 'server.js'), timeoutMs = 120000 }) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.notifications = [];
    const env = { ...process.env };
    if (configPath) env.CLANGD_BRIDGE_CONFIG = configPath;
    this.child = spawn(process.execPath, [serverPath], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > 200000) this.stderr = this.stderr.slice(-200000);
    });
    this.rl = readline.createInterface({ input: this.child.stdout, terminal: false });
    this.rl.on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new Error(`server 输出了非 JSON：${text.slice(0, 200)}`);
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
      return;
    }
    if (message.method) this.notifications.push(message);
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-clangd-bridge-tests', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    return res;
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    return res.result.tools;
  }

  // 返回 { result, isError, raw }，result 为工具 JSON 文本解析后的对象。
  async callTool(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) {
      return { result: null, isError: true, raw: res, error: res.error };
    }
    const text = res.result && res.result.content && res.result.content[0] ? res.result.content[0].text : '{}';
    return {
      result: JSON.parse(text),
      isError: Boolean(res.result && res.result.isError),
      raw: res,
    };
  }

  async close() {
    try {
      await this.request('shutdown', null);
    } catch {
      // 忽略
    }
    this.rl.close();
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function withClient(options, fn) {
  const client = new McpClient(options);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
