// MCP stdio server：换行分隔的 JSON-RPC 2.0（MCP 规范），初始化阶段绝不 spawn clangd。
// stdout 只写协议消息；日志一律走 stderr / 文件（见 log.js）。

import readline from 'node:readline';
import { loadConfig } from './config.js';
import { toBridgeError } from './errors.js';
import { createLogger } from './log.js';
import { LspClient } from './lsp/client.js';
import { DocumentStore } from './lsp/documents.js';
import { listTools, getTool } from './tools/index.js';

const SERVER_NAME = 'clangd-bridge';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: '2.0', id, error });
}

function fallbackConfig() {
  return {
    clangdPath: null,
    clangdPathSource: 'config',
    projectRoot: null,
    compileCommandsDir: null,
    allowedRoots: [],
    requireCompileDb: true,
    backgroundIndex: true,
    clangTidy: false,
    queryDriver: null,
    queryDriverRequested: null,
    queryDriverIssue: null,
    allowQueryDriver: false,
    startupTimeoutMs: 30000,
    requestTimeoutMs: 30000,
    diagnosticsWaitMs: 2000,
    maxResults: 200,
    maxFileBytes: 8388608,
    maxOpenDocuments: 16,
    maxRestartsPerHour: 3,
    maxWorkspaceQueryLength: 128,
    env: {},
    log: { level: 'error', dir: null, maxBytes: 5 * 1024 * 1024, maxFiles: 3 },
  };
}

async function main() {
  const argv = process.argv.slice(2);

  let loaded;
  let configError = null;
  try {
    loaded = loadConfig({ argv, env: process.env, cwd: process.cwd() });
  } catch (err) {
    configError = toBridgeError(err, null);
    loaded = {
      config: fallbackConfig(),
      warnings: [`配置加载失败：${configError.message}`],
      configPath: null,
    };
  }

  if (argv.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify({ configPath: loaded.configPath, config: loaded.config, warnings: loaded.warnings }, null, 2)}\n`);
    process.exit(0);
  }

  const logger = createLogger(loaded.config);
  const client = new LspClient(loaded.config, logger);
  const documents = new DocumentStore({ config: loaded.config, client, logger });
  const ctx = {
    config: loaded.config,
    client,
    documents,
    logger,
    configWarnings: loaded.warnings,
    configError,
    configPath: loaded.configPath,
  };

  logger.info('server.start', {
    version: SERVER_VERSION,
    configPath: loaded.configPath,
    projectRoot: loaded.config.projectRoot,
    configError: configError ? configError.code : null,
    pid: process.pid,
  });

  let closing = false;
  async function cleanup(reason) {
    if (closing) return;
    closing = true;
    logger.info('server.stop', { reason });
    try {
      await documents.closeAll();
    } catch {
      // 进程可能已退出
    }
    try {
      await client.stop();
    } catch {
      // 忽略
    }
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (err) {
      sendError(null, -32700, `JSON 解析失败：${String(err && err.message)}`);
      return;
    }
    handleMessage(message).catch((err) => {
      logger.error('server.handle-failed', { error: String(err && err.stack ? err.stack : err) });
    });
  });

  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendError(null, -32600, '非法的 JSON-RPC 消息');
      return;
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (isNotification) {
      if (method === 'notifications/initialized') {
        logger.debug('server.initialized', {});
        return;
      }
      if (method === 'exit') {
        await cleanup('exit-notification');
        process.exit(0);
      }
      if (method === 'notifications/cancelled' || method === '$/cancelRequest') return;
      logger.debug('server.notification', { method });
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
        sendResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'clangd 桥：只读的 C/C++ 代码智能。先调用 clangd_health（start:true 可预热）确认 compile db 与 clangd 可用；其它工具的位置参数从 1 开始（UTF-16 列）。',
        });
        return;
      }
      case 'ping': {
        sendResult(id, {});
        return;
      }
      case 'tools/list': {
        sendResult(id, { tools: listTools() });
        return;
      }
      case 'tools/call': {
        const name = params && params.name;
        const tool = typeof name === 'string' ? getTool(name) : null;
        if (!tool) {
          sendError(id, -32602, `未知工具：${String(name)}`, { code: 'MCP_PROTOCOL_ERROR' });
          return;
        }
        const args = params && params.arguments !== undefined ? params.arguments : {};
        try {
          const result = await tool.handler(ctx, args);
          sendResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: false,
          });
        } catch (err) {
          const bridgeError = toBridgeError(err, logger);
          logger.warn('tool.failed', { tool: name, code: bridgeError.code, message: bridgeError.message });
          const payload = bridgeError.toResult({ tool: name });
          // 业务失败走正常工具结果（isError:false），由 agent 读 code/hint 处理。
          sendResult(id, {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            isError: bridgeError.code === 'MCP_PROTOCOL_ERROR',
          });
        }
        return;
      }
      case 'resources/list': {
        sendResult(id, { resources: [], resourceTemplates: [] });
        return;
      }
      case 'prompts/list': {
        sendResult(id, { prompts: [] });
        return;
      }
      case 'shutdown': {
        await cleanup('shutdown-request');
        sendResult(id, null);
        setTimeout(() => process.exit(0), 20);
        return;
      }
      default: {
        sendError(id, -32601, `不支持的方法：${String(method)}`, { code: 'MCP_PROTOCOL_ERROR' });
      }
    }
  }

  rl.on('close', async () => {
    await cleanup('stdin-closed');
    process.exit(0);
  });

  const onSignal = (signal) => {
    cleanup(`signal:${signal}`).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.error('server.uncaught', { error: String(err && err.stack ? err.stack : err) });
  });
  process.on('unhandledRejection', (err) => {
    logger.error('server.unhandled-rejection', { error: String(err && err.stack ? err.stack : err) });
  });
}

main().catch((err) => {
  process.stderr.write(`clangd-bridge 启动失败：${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
