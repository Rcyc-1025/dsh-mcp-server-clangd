// 配置加载：优先级 显式 CLI 参数 > 环境变量 > 配置文件 > 默认值。
// 配置只读不热更新；改动需重启 MCP server。
// 缺少 projectRoot 不抛异常（health 需要能报告“为什么不能用”），由工具层返回 PROJECT_NOT_CONFIGURED。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './errors.js';
import { realpathOrNull } from './paths.js';

const ENV_ENV_WHITELIST = /^(PATH|INCLUDE|LIB|LIBPATH|SYSTEMROOT|SYSTEMDRIVE|TEMP|TMP|CLANGD_[A-Z0-9_]*|VCToolsInstallDir|WindowsSdkDir|UCRTVersion)$/;

const DEFAULTS = {
  clangdPath: null,
  projectRoot: null,
  compileCommandsDir: null,
  allowedRoots: null,
  requireCompileDb: true,
  backgroundIndex: true,
  clangTidy: false,
  queryDriver: null,
  allowQueryDriver: false,
  startupTimeoutMs: 30000,
  requestTimeoutMs: 30000,
  diagnosticsWaitMs: 2000,
  maxResults: 200,
  maxFileBytes: 8388608,
  maxOpenDocuments: 16,
  maxRestartsPerHour: 3,
  env: {},
  log: {
    level: 'info',
    dir: null,
    maxBytes: 5 * 1024 * 1024,
    maxFiles: 3,
  },
};

const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

function fail(message, details = {}) {
  throw new BridgeError('CONFIG_INVALID', message, details);
}

function asBool(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  fail(`${name} 必须是布尔值`, { field: name, value: String(value) });
  return undefined;
}

function asInt(value, name, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) fail(`${name} 必须是整数`, { field: name, value: String(value) });
  if (n < min || n > max) fail(`${name} 必须在 ${min}..${max} 之间`, { field: name, value: n, min, max });
  return n;
}

function asString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${name} 必须是字符串`, { field: name, type: typeof value });
  return value;
}

export function parseCliArgs(argv) {
  const out = { configPath: null, printConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') {
      out.configPath = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--config=')) {
      out.configPath = arg.slice('--config='.length);
    } else if (arg === '--print-config') {
      out.printConfig = true;
    }
  }
  return out;
}

function readConfigFile(configPath, warnings) {
  if (!configPath) return { data: {}, path: null };
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    // 显式指定的配置不存在属于硬错误；默认路径不存在则用默认值。
    throw new BridgeError('CONFIG_INVALID', '配置文件无法读取', {
      configPath,
      cause: String(err && err.message),
    });
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('配置文件顶层必须是对象', { configPath });
    }
    return { data: parsed, path: configPath };
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError('CONFIG_INVALID', '配置文件不是合法 JSON', {
      configPath,
      cause: String(err && err.message).slice(0, 300),
    });
  }
}

function normalizeEnvMap(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('env 必须是对象', { field: 'env' });
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_ENV_WHITELIST.test(key)) {
      fail(`env 键不允许：${key}（仅允许 PATH/INCLUDE/LIB/LIBPATH/CLANGD_* 等）`, { field: 'env', key });
    }
    if (typeof value !== 'string') fail(`env.${key} 必须是字符串`, { field: `env.${key}` });
    out[key] = value;
  }
  return out;
}

function normalizeLog(raw, projectRoot) {
  const log = { ...DEFAULTS.log, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  if (!LOG_LEVELS.has(log.level)) fail(`log.level 必须是 ${[...LOG_LEVELS].join('/')}`, { field: 'log.level' });
  if (log.dir !== null && typeof log.dir !== 'string') fail('log.dir 必须是字符串', { field: 'log.dir' });
  if (!log.dir) log.dir = path.join(os.tmpdir(), 'dsh-clangd-bridge', 'logs');
  log.maxBytes = asInt(log.maxBytes, 'log.maxBytes', 1024, 100 * 1024 * 1024) ?? DEFAULTS.log.maxBytes;
  log.maxFiles = asInt(log.maxFiles, 'log.maxFiles', 1, 20) ?? DEFAULTS.log.maxFiles;
  void projectRoot;
  return log;
}

function resolveAllowedRoots(rawRoots, projectRoot, warnings) {
  const list = Array.isArray(rawRoots) ? rawRoots.slice() : rawRoots ? [rawRoots] : [];
  const roots = [];
  if (projectRoot) roots.push(projectRoot);
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail('allowedRoots 只能包含非空字符串', { field: 'allowedRoots' });
    }
    roots.push(item);
  }
  const resolved = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    const real = realpathOrNull(abs);
    if (!real) {
      warnings.push(`allowedRoots 条目不存在，已按字面路径使用：${abs}`);
      resolved.push(abs);
    } else {
      resolved.push(real);
    }
  }
  return [...new Set(resolved.map((r) => r))];
}

// 在 PATH / PATHEXT 中查找 clangd；只在 clangdPath 未配置且 CLANGD_PATH 未设置时使用。
export function findClangdOnPath(env = process.env) {
  const pathVar = env.PATH || env.Path || '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `clangd${ext.toLowerCase()}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      const candidateUpper = path.join(dir, `clangd${ext.toUpperCase()}`);
      if (candidateUpper !== candidate && fs.existsSync(candidateUpper) && fs.statSync(candidateUpper).isFile()) {
        return candidateUpper;
      }
    }
  }
  return null;
}

export function resolveClangdPath(config) {
  if (config.clangdPath) {
    return { path: config.clangdPath, source: config.clangdPathSource || 'config' };
  }
  const fromPath = findClangdOnPath(config.env || process.env);
  if (fromPath) return { path: fromPath, source: 'path' };
  return { path: null, source: 'none' };
}

export function loadConfig({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const warnings = [];
  const cli = parseCliArgs(argv);

  const configPath =
    cli.configPath ||
    env.CLANGD_BRIDGE_CONFIG ||
    (fs.existsSync(path.join(cwd, 'clangd-bridge.json')) ? path.join(cwd, 'clangd-bridge.json') : null);
  const file = readConfigFile(configPath, warnings);
  const raw = { ...file.data };

  // 环境变量覆盖
  if (env.CLANGD_PATH) raw.clangdPath = env.CLANGD_PATH;
  if (env.CLANGD_PROJECT_ROOT) raw.projectRoot = env.CLANGD_PROJECT_ROOT;
  if (env.CLANGD_COMPILE_COMMANDS_DIR) raw.compileCommandsDir = env.CLANGD_COMPILE_COMMANDS_DIR;
  if (env.CLANGD_ALLOWED_ROOTS) raw.allowedRoots = env.CLANGD_ALLOWED_ROOTS.split(';').filter(Boolean);
  if (env.CLANGD_REQUEST_TIMEOUT_MS) raw.requestTimeoutMs = env.CLANGD_REQUEST_TIMEOUT_MS;
  if (env.CLANGD_LOG_LEVEL) {
    raw.log = { ...(raw.log && typeof raw.log === 'object' ? raw.log : {}), level: env.CLANGD_LOG_LEVEL };
  }

  const config = { ...DEFAULTS };

  const projectRoot = asString(raw.projectRoot, 'projectRoot');
  config.projectRoot = projectRoot ? path.resolve(cwd, projectRoot) : null;
  if (config.projectRoot && !fs.existsSync(config.projectRoot)) {
    warnings.push(`projectRoot 不存在：${config.projectRoot}`);
  }

  const clangdPath = asString(raw.clangdPath, 'clangdPath');
  config.clangdPath = clangdPath ? path.resolve(cwd, clangdPath) : null;
  config.clangdPathSource = env.CLANGD_PATH && (!file.data.clangdPath || env.CLANGD_PATH !== file.data.clangdPath)
    ? 'env'
    : 'config';

  const compileDir = asString(raw.compileCommandsDir, 'compileCommandsDir');
  config.compileCommandsDir = compileDir
    ? path.resolve(config.projectRoot || cwd, compileDir)
    : config.projectRoot;

  config.allowedRoots = resolveAllowedRoots(raw.allowedRoots, config.projectRoot, warnings);

  for (const [key, def] of Object.entries({
    requireCompileDb: [true, null],
    backgroundIndex: [true, null],
    clangTidy: [false, null],
    allowQueryDriver: [false, null],
  })) {
    const value = asBool(raw[key], key);
    config[key] = value === undefined ? def[0] : value;
  }

  config.queryDriver = asString(raw.queryDriver, 'queryDriver') || null;
  if (config.queryDriver && !config.allowQueryDriver) {
    warnings.push('检测到 queryDriver 但 allowQueryDriver 不为 true，已忽略；queryDriver 属于高风险能力。');
    config.queryDriver = null;
  }

  config.startupTimeoutMs = asInt(raw.startupTimeoutMs, 'startupTimeoutMs', 1000, 120000) ?? DEFAULTS.startupTimeoutMs;
  config.requestTimeoutMs = asInt(raw.requestTimeoutMs, 'requestTimeoutMs', 1000, 120000) ?? DEFAULTS.requestTimeoutMs;
  config.diagnosticsWaitMs = asInt(raw.diagnosticsWaitMs, 'diagnosticsWaitMs', 0, 10000) ?? DEFAULTS.diagnosticsWaitMs;
  config.maxResults = asInt(raw.maxResults, 'maxResults', 1, 1000) ?? DEFAULTS.maxResults;
  config.maxFileBytes = asInt(raw.maxFileBytes, 'maxFileBytes', 1024, 64 * 1024 * 1024) ?? DEFAULTS.maxFileBytes;
  config.maxOpenDocuments = asInt(raw.maxOpenDocuments, 'maxOpenDocuments', 1, 64) ?? DEFAULTS.maxOpenDocuments;
  config.maxRestartsPerHour = asInt(raw.maxRestartsPerHour, 'maxRestartsPerHour', 0, 10) ?? DEFAULTS.maxRestartsPerHour;

  config.env = normalizeEnvMap(raw.env);
  config.log = normalizeLog(raw.log, config.projectRoot);

  return {
    config,
    warnings,
    configPath: file.path,
    clangd: resolveClangdPath(config),
    configured: Boolean(config.projectRoot),
  };
}
