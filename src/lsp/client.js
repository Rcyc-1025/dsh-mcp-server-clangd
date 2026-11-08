// clangd 进程生命周期：懒启动、initialize/initialized、请求超时与取消、崩溃检测、
// 重启上限（每小时）与指数退避、stderr 环形缓冲、publishDiagnostics 缓存。
// 启动互斥：同一时刻只允许一个 initialize。

import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { inspectCompileDb, isMsvcDb } from '../compileDb.js';
import { resolveClangdPath } from '../config.js';
import { queryDriverProblem } from '../paths.js';
import { pathToFileURL } from 'node:url';
import { LspFramer, encodeMessage } from './framing.js';

export const PROCESS_STATE = {
  NOT_STARTED: 'not_started',
  STARTING: 'starting',
  READY: 'ready',
  CRASHED: 'crashed',
  STOPPED: 'stopped',
};

const STDERR_TAIL_BYTES = 64 * 1024;

function expandEnvValue(value, baseEnv) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    const lookup = baseEnv[key] ?? baseEnv[name] ?? baseEnv[key.toLowerCase()];
    return lookup === undefined ? whole : lookup;
  });
}

function buildEnv(config) {
  const out = { ...process.env };
  for (const [key, value] of Object.entries(config.env || {})) {
    out[key] = expandEnvValue(value, process.env);
  }
  return out;
}

export class LspClient extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.state = PROCESS_STATE.NOT_STARTED;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.restarts = 0;
    this.startCount = 0;
    this.restartTimestamps = [];
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.framer = null;
    this.stderrTail = '';
    this.versionInfo = null;
    this.diagnostics = new Map(); // uri -> { version, diagnostics, receivedAt }
    this.diagnosticsWaiters = new Map(); // uri -> Set<resolve>
    this.stopping = false;
    this.lastExit = null;
    this.compileDbOverride = null;
  }

  get info() {
    return {
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
    };
  }

  stderrTailText() {
    return this.stderrTail;
  }

  ensureConfig() {
    if (!this.config.projectRoot) {
      throw new BridgeError('PROJECT_NOT_CONFIGURED', '缺少 projectRoot 配置', {});
    }
  }

  // 数据工具的前置校验：compile db 必须先通过，否则不 spawn。
  assertCompileDb() {
    if (!this.config.requireCompileDb) return null;
    const status = inspectCompileDb(this.config.compileCommandsDir);
    if (!status.exists) {
      throw new BridgeError('COMPILE_COMMANDS_MISSING', '找不到 compile_commands.json', {
        compileCommandsDir: this.config.compileCommandsDir,
        checkedPath: status.path,
      });
    }
    if (!status.valid) {
      throw new BridgeError('COMPILE_COMMANDS_INVALID', 'compile_commands.json 内容非法', {
        compileCommandsDir: this.config.compileCommandsDir,
        error: status.error,
        invalidEntries: status.invalidEntries,
        entries: status.entries,
      });
    }
    return status;
  }

  compileDbStatus() {
    return inspectCompileDb(this.config.compileCommandsDir);
  }

  resolveBinary() {
    const resolved = this.config.clangdPath
      ? { path: this.config.clangdPath, source: this.config.clangdPathSource || 'config' }
      : resolveClangdPath(this.config);
    if (!resolved.path) {
      throw new BridgeError('CLANGD_NOT_FOUND', '找不到 clangd 可执行文件', {
        clangdPath: null,
        searched: ['config.clangdPath', 'CLANGD_PATH', 'PATH'],
      });
    }
    if (!fs.existsSync(resolved.path)) {
      throw new BridgeError('CLANGD_NOT_FOUND', 'clangd 路径不存在', { clangdPath: resolved.path });
    }
    return resolved;
  }

  // clangd --version：短超时探测，失败只记录，不阻塞启动（health 用它）。
  async probeVersion() {
    const binary = this.resolveBinary();
    return new Promise((resolve) => {
      execFile(binary.path, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
        const text = `${stdout || ''}${stderr || ''}`;
        const match = text.match(/clangd version\s+(\d+)\.(\d+)\.(\d+)/i);
        const out = {
          path: binary.path,
          source: binary.source,
          exists: true,
          version: match ? `clangd version ${match[1]}.${match[2]}.${match[3]}` : 'unknown',
          major: match ? Number(match[1]) : null,
          raw: text.trim().split(/\r?\n/)[0] || '',
        };
        if (err && !match) out.error = String(err.message || err).slice(0, 300);
        this.versionInfo = out;
        resolve(out);
      });
    });
  }

  buildArgs() {
    const args = [
      `--compile-commands-dir=${this.config.compileCommandsDir}`,
      this.config.backgroundIndex ? '--background-index' : '--background-index=0',
      '--header-insertion=never',
      '--log=error',
      '--pch-storage=memory',
    ];
    if (this.config.clangTidy) args.push('--clang-tidy');
    if (this.config.queryDriver) {
      if (!this.config.allowQueryDriver) {
        throw new BridgeError('CONFIG_INVALID', 'queryDriver 需要 allowQueryDriver: true', {
          queryDriver: this.config.queryDriver,
        });
      }
      // 双层校验：即使配置对象被直接构造，也不允许把 clangd 的编译器驱动指向 allowedRoots 之外。
      const problem = queryDriverProblem(this.config.queryDriver, this.config.allowedRoots || []);
      if (problem) {
        throw new BridgeError('CONFIG_INVALID', `queryDriver 不可用：${problem}`, {
          queryDriver: this.config.queryDriver,
          allowedRoots: (this.config.allowedRoots || []).slice(),
        });
      }
      args.push(`--query-driver=${this.config.queryDriver}`);
    }
    return args;
  }

  initializeParams() {
    const rootUri = pathToFileURL(this.config.projectRoot).href;
    return {
      processId: process.pid,
      clientInfo: { name: 'dsh-clangd-bridge', version: '0.1.0' },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.config.projectRoot) }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceFolders: true, symbol: {} },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            didSave: false,
            willSaveWaitUntil: false,
          },
          definition: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
      },
    };
  }

  send(message) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new BridgeError('CLANGD_CRASHED', 'clangd 进程不可写', { state: this.state, pid: this.pid });
    }
    this.child.stdin.write(encodeMessage(message));
  }

  requestRaw(method, params, timeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.notify('$/cancelRequest', { id });
        } catch {
          // 进程可能已退出
        }
        reject(
          new BridgeError('LSP_REQUEST_TIMEOUT', `LSP 请求超时：${method}`, {
            method,
            requestId: id,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer, startedAt });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  handleResponse(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new BridgeError('LSP_ERROR', `clangd 返回错误：${message.error.message || 'unknown'}`, {
          method: entry.method,
          requestId: message.id,
          errorCode: message.error.code,
          errorMessage: message.error.message,
        }),
      );
      return;
    }
    entry.resolve(message.result);
  }

  handleServerRequest(message) {
    const { method, id } = message;
    let result = null;
    if (method === 'workspace/configuration') {
      const items = (message.params && message.params.items) || [];
      result = items.map(() => null);
    } else if (method === 'workspace/workspaceFolders') {
      const rootUri = pathToFileURL(this.config.projectRoot).href;
      result = [{ uri: rootUri, name: path.basename(this.config.projectRoot) }];
    } else if (method === 'client/registerCapability' || method === 'window/workDoneProgress/create') {
      result = null;
    } else {
      this.logger.debug('lsp.serverRequest', { method });
      result = null;
    }
    try {
      this.send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      this.logger.warn('lsp.serverRequest.reply-failed', { method, error: String(err && err.message) });
    }
  }

  handleNotification(message) {
    const { method, params } = message;
    if (method === 'textDocument/publishDiagnostics' && params && params.uri) {
      const previous = this.diagnostics.get(params.uri);
      const entry = {
        version: typeof params.version === 'number' ? params.version : null,
        diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
        receivedAt: Date.now(),
        seq: previous ? previous.seq + 1 : 1,
      };
      this.diagnostics.set(params.uri, entry);
      const waiters = this.diagnosticsWaiters.get(params.uri);
      if (waiters && waiters.size > 0) {
        for (const resolve of [...waiters]) resolve(entry);
        waiters.clear();
      }
      this.emit('diagnostics', params.uri, entry);
      return;
    }
    if (method === 'window/showMessage' || method === 'window/logMessage') {
      this.logger.debug('lsp.message', { method, message: params && params.message });
      return;
    }
    this.logger.debug('lsp.notification', { method });
  }

  attachProcess(child) {
    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = new Date().toISOString();
    this.state = PROCESS_STATE.STARTING;

    this.framer = new LspFramer({
      onMessage: (message) => {
        if (message && message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined) && !message.method) {
          this.handleResponse(message);
        } else if (message && message.method && message.id !== undefined && message.id !== null) {
          this.handleServerRequest(message);
        } else if (message && message.method) {
          this.handleNotification(message);
        }
      },
      onError: (err) => this.logger.warn('lsp.framing', { error: String(err && err.message) }),
    });

    child.stdout.on('data', (chunk) => this.framer.push(chunk));

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrTail += text;
      if (this.stderrTail.length > STDERR_TAIL_BYTES) {
        this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_BYTES);
      }
      const trimmed = text.trim();
      if (trimmed) this.logger.debug('clangd.stderr', { line: trimmed.slice(0, 500) });
    });

    child.on('error', (err) => {
      this.logger.error('clangd.spawn-error', { error: String(err && err.message) });
      this.failPending(
        new BridgeError('CLANGD_START_FAILED', 'clangd 启动失败', {
          error: String(err && err.message),
          stderrTail: this.stderrTail,
        }),
      );
      this.state = PROCESS_STATE.CRASHED;
      this.lastExit = { error: String(err && err.message), at: new Date().toISOString() };
    });

    child.on('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.stopping = false;
      this.child = null;
      this.pid = null;
      this.lastExit = { exitCode: code, signal: signal || null, at: new Date().toISOString() };
      if (wasStopping || this.state === PROCESS_STATE.STOPPED) {
        this.state = PROCESS_STATE.STOPPED;
      } else {
        this.state = PROCESS_STATE.CRASHED;
      }
      this.logger.warn('clangd.exit', { exitCode: code, signal, stopping: wasStopping });
      this.failPending(
        new BridgeError('CLANGD_CRASHED', 'clangd 进程已退出', {
          exitCode: code,
          signal: signal || null,
          stderrTail: this.stderrTail,
          restarts: this.restarts,
        }),
      );
      // 旧进程的诊断不再有效；同时让等待 publishDiagnostics 的调用立即返回 pending。
      this.clearAllDiagnostics();
      this.emit('exit', code, signal);
    });
  }

  failPending(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async start() {
    this.ensureConfig();
    const compileStatus = this.assertCompileDb();

    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < 60 * 60 * 1000);
    if (this.startCount > 0) {
      if (this.restartTimestamps.length >= this.config.maxRestartsPerHour) {
        throw new BridgeError('CLANGD_CRASHED', 'clangd 崩溃重启次数超过每小时上限', {
          restarts: this.restarts,
          maxRestartsPerHour: this.config.maxRestartsPerHour,
          lastExit: this.lastExit,
          stderrTail: this.stderrTail,
        });
      }
      const delay = Math.min(2000, 500 * 2 ** Math.max(0, this.restartTimestamps.length - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const binary = this.resolveBinary();
    const version = this.versionInfo || (await this.probeVersion());
    if (version && version.major !== null && version.major < 16) {
      throw new BridgeError('CLANGD_VERSION_UNSUPPORTED', 'clangd 版本过低（要求 >= 16）', {
        version: version.version,
        path: version.path,
      });
    }

    const args = this.buildArgs();
    this.logger.info('clangd.start', {
      path: binary.path,
      args,
      compileCommandsDir: this.config.compileCommandsDir,
      entries: compileStatus ? compileStatus.entries : null,
    });

    let child;
    try {
      child = spawn(binary.path, args, {
        cwd: this.config.projectRoot,
        env: buildEnv(this.config),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      throw new BridgeError('CLANGD_START_FAILED', '无法启动 clangd 进程', {
        error: String(err && err.message),
      });
    }

    this.attachProcess(child);

    let initResult;
    try {
      initResult = await this.requestRaw('initialize', this.initializeParams(), this.config.startupTimeoutMs);
    } catch (err) {
      const code = err && err.code === 'LSP_REQUEST_TIMEOUT' ? 'CLANGD_INIT_TIMEOUT' : 'CLANGD_INIT_ERROR';
      this.killChild();
      this.state = PROCESS_STATE.CRASHED;
      throw new BridgeError(code, `clangd initialize 失败：${String(err && err.message)}`, {
        error: err && err.details ? err.details : String(err && err.message),
        stderrTail: this.stderrTail,
      });
    }

    try {
      this.notify('initialized', {});
    } catch (err) {
      this.killChild();
      throw new BridgeError('CLANGD_INIT_ERROR', '发送 initialized 通知失败', {
        error: String(err && err.message),
      });
    }

    const serverVersion = initResult && initResult.serverInfo ? initResult.serverInfo.version : null;
    this.state = PROCESS_STATE.READY;
    this.startCount += 1;
    if (this.startCount > 1) this.restarts += 1;
    this.restartTimestamps.push(Date.now());
    this.logger.info('clangd.ready', { pid: this.pid, serverVersion, entries: compileStatus ? compileStatus.entries : null });

    return {
      pid: this.pid,
      serverVersion,
      capabilities: initResult ? initResult.capabilities : null,
      compileDb: compileStatus,
    };
  }

  async ensureStarted() {
    this.ensureConfig();
    if (this.state === PROCESS_STATE.READY) return this.info;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start()
      .catch((err) => {
        if (this.state === PROCESS_STATE.STARTING) this.state = PROCESS_STATE.CRASHED;
        throw err;
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async assertReadyForQueries() {
    this.ensureConfig();
    this.assertCompileDb();
    await this.ensureStarted();
  }

  async request(method, params, timeoutMs = this.config.requestTimeoutMs) {
    if (this.state !== PROCESS_STATE.READY) {
      throw new BridgeError('CLANGD_CRASHED', 'clangd 未就绪', { state: this.state, pid: this.pid });
    }
    return this.requestRaw(method, params, timeoutMs);
  }

  diagnosticsFor(uri) {
    return this.diagnostics.get(uri) || null;
  }

  // 首次 didOpen / 内容变化时调用：旧版本的诊断必须丢弃，否则会把上一次的诊断当成当前结果返回。
  clearDiagnostics(uri) {
    this.diagnostics.delete(uri);
  }

  // clangd 退出/重启后，旧诊断与旧版本都不再有意义：清空缓存并让等待方立即返回 null（pending）。
  clearAllDiagnostics() {
    this.diagnostics.clear();
    for (const [uri, set] of [...this.diagnosticsWaiters]) {
      for (const waiter of [...set]) {
        if (typeof waiter.cancel === 'function') waiter.cancel();
      }
      this.diagnosticsWaiters.delete(uri);
    }
  }

  // 等待与指定 uri 的诊断（版本 >= minVersion）；超时返回 null，由调用方标记 pending。
  waitForDiagnostics(uri, minVersion, waitMs) {
    const cached = this.diagnostics.get(uri);
    if (cached && (minVersion === null || cached.version === null || cached.version >= minVersion)) return Promise.resolve(cached);
    if (!waitMs || waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const set = this.diagnosticsWaiters.get(uri) || new Set();
      this.diagnosticsWaiters.set(uri, set);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        set.delete(waiter);
        if (set.size === 0) this.diagnosticsWaiters.delete(uri);
        resolve(value);
      };
      const waiter = (entry) => {
        if (minVersion === null || entry.version === null || entry.version >= minVersion) finish(entry);
      };
      waiter.cancel = () => finish(null);
      const timer = setTimeout(() => finish(null), waitMs);
      set.add(waiter);
    });
  }

  killChild() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // 忽略
    }
  }

  async stop() {
    if (!this.child) {
      this.state = PROCESS_STATE.STOPPED;
      return { stopped: true, graceful: false };
    }
    this.stopping = true;
    const child = this.child;
    let graceful = false;
    try {
      await Promise.race([
        this.requestRaw('shutdown', null, 2000),
        new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 2000)),
      ]);
      graceful = true;
    } catch {
      graceful = false;
    }
    try {
      this.notify('exit', {});
    } catch {
      // 进程可能已退出
    }
    const exited = await new Promise((resolve) => {
      if (!this.child) return resolve(true);
      const timer = setTimeout(() => resolve(false), 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && this.child) {
      this.logger.warn('clangd.stop.kill', { pid: this.pid });
      try {
        this.child.kill('SIGKILL');
      } catch {
        // 忽略
      }
      if (process.platform === 'win32' && this.pid) {
        try {
          execFile('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } catch {
          // 忽略
        }
      }
    }
    this.state = PROCESS_STATE.STOPPED;
    return { stopped: true, graceful };
  }
}

export { isMsvcDb };
