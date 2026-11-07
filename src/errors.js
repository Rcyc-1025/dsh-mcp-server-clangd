// 统一错误模型：所有业务错误都包成 ok:false 的正常工具结果，不抛给 MCP 层。
// 错误码与 hint 以规格 §12 为准；CONFIG_INVALID 是桥内部新增（配置非法时使用），已在 README 记录。

export const ERROR_HINTS = {
  INVALID_ARGUMENT: '按工具 schema 修正参数；行/列从 1 开始计数。',
  PROJECT_NOT_CONFIGURED: '在 clangd-bridge.json 配置 projectRoot，或设置环境变量 CLANGD_PROJECT_ROOT。',
  PATH_OUTSIDE_ALLOWED_ROOTS: '把源码/构建根加入 allowedRoots；不要用 .. 或符号链接逃逸。',
  FILE_NOT_FOUND: '检查绝对路径与文件权限；相对路径按 projectRoot 解析。',
  FILE_TOO_LARGE: '提高 maxFileBytes，或换较小的文件；不要用桥打开巨型生成文件。',
  UNSUPPORTED_LANGUAGE: '只支持 .c/.cpp/.cc/.cxx/.h/.hpp 等 C/C++ 源文件与头文件。',
  POSITION_OUT_OF_RANGE: 'line/column 从 1 开始；检查文件行数与 UTF-16 列偏移。',
  QUERY_TOO_LONG: '缩短 workspace_symbols 的 query（最多 128 字符）。',
  LIMIT_OUT_OF_RANGE: 'limit 必须在 1..maxResults 之间。',
  COMPILE_COMMANDS_MISSING:
    '检查 compileCommandsDir 是否含 compile_commands.json；CMake 可用 -DCMAKE_EXPORT_COMPILE_COMMANDS=ON 生成。',
  COMPILE_COMMANDS_INVALID: '重新生成 compile_commands.json；条目需含 directory/file 与 command 或 arguments。',
  CLANGD_NOT_FOUND: '在配置里设置 clangdPath，或设置 CLANGD_PATH，或把 clangd 加入 PATH；建议用绝对路径。',
  CLANGD_VERSION_UNSUPPORTED: '升级 clangd 到 16 或更高版本；本机实测 23.1.4。',
  CLANGD_START_FAILED: '查看 details.stderrTail；检查 PATH、权限与杀毒软件拦截。',
  CLANGD_INIT_TIMEOUT: '增大 startupTimeoutMs；查看 clangd 日志与 compile db 是否过大。',
  CLANGD_INIT_ERROR: '查看 details.error；多为 compile db 或启动参数问题。',
  CLANGD_CRASHED: '查看 exitCode/stderrTail；下一次调用会在重启上限内自动重启一次。',
  LSP_REQUEST_TIMEOUT: '增大 requestTimeoutMs；缩小 query 或文件；等待索引完成。',
  LSP_ERROR: '保留 code/message；查看 clangd 日志定位。',
  INTERNAL_ERROR: '附 logPath/stderrTail 反馈 bug；bridge 不应因单个请求退出。',
  MCP_PROTOCOL_ERROR: '检查 MCP client 发送的 JSON-RPC 是否合法。',
  CONFIG_INVALID: '修正 clangd-bridge.json 的类型/范围；可参考 clangd-bridge.example.json。',
};

export class BridgeError extends Error {
  constructor(code, message, details = {}, hint = undefined) {
    super(message || code);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details && typeof details === 'object' ? details : {};
    this.hint = hint ?? ERROR_HINTS[code] ?? '';
  }

  toResult(extra = {}) {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
      ...extra,
    };
  }
}

export function isBridgeError(err) {
  return err instanceof BridgeError || (err && typeof err.code === 'string' && ERROR_HINTS[err.code] !== undefined);
}

// 把任意异常翻译成 BridgeError：不允许 ENOENT / JSON.parse 异常原样冒到 MCP 层。
export function toBridgeError(err, logger, fallbackCode = 'INTERNAL_ERROR') {
  if (err instanceof BridgeError) return err;
  const code = err && typeof err.code === 'string' && ERROR_HINTS[err.code] ? err.code : fallbackCode;
  const details = {
    cause: err && err.name ? err.name : 'Error',
    errorMessage: err && err.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
  };
  if (err && err.syscall) details.syscall = err.syscall;
  if (err && err.errno) details.errno = err.errno;
  if (logger && typeof logger.stderrTail === 'function') details.stderrTail = logger.stderrTail();
  return new BridgeError(code, String((err && err.message) || err).slice(0, 500), details);
}

export function invalidArgument(message, details = {}) {
  return new BridgeError('INVALID_ARGUMENT', message, details);
}
