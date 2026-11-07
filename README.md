# dsh-mcp-server-clangd

把 [clangd](https://clangd.llvm.org/) 包成一个 **stdio MCP server**，向 DSH（DeepSeek Harness）里的 agent 暴露 7 个只读的 C/C++ 语义查询工具：定义、悬停、引用、诊断、文档符号、工作区符号、健康检查。

- 零第三方依赖：MCP JSON-RPC 与 LSP 客户端都是手写的（Node.js ≥ 20，ESM，只用 `node:` 内置模块）。
- **只读**：不发送 rename / format / codeAction / applyEdit，不写你的源码。
- 位置统一 **1-based**（行、列），列按 UTF-16 码元计；内部再转成 LSP 的 0-based。
- 业务失败不抛给 MCP 层：始终返回 `{ok:false, code, message, hint, details}`，`isError` 为 `false`，agent 能读懂错误并自行纠正参数。

## 为什么需要它

clangd 只说 LSP，DSH agent 只会调 MCP 工具。中间这层桥负责：

1. 管好 clangd 进程（懒启动、崩溃重启、退出清理）；
2. 把 `compile_commands.json`、路径白名单、文件大小、请求超时这些工程性约束前置成结构化错误；
3. 把 LSP 的 0-based 位置、`Location | LocationLink`、`MarkupContent` 等细节归一成稳定的 JSON。

## 工具

| 工具 | LSP 方法 | 说明 |
| --- | --- | --- |
| `clangd_health` | —（+ `clangd --version`） | 配置/compile db/clangd 路径与进程状态；`start:true` 时预热 clangd |
| `clangd_definition` | `textDocument/definition` | 跳转到定义/声明 |
| `clangd_hover` | `textDocument/hover` | 类型与签名（markdown 文本） |
| `clangd_references` | `textDocument/references` | 全工程引用（默认含声明） |
| `clangd_diagnostics` | `textDocument/didOpen`/`didChange` + `publishDiagnostics` | 打开文档并等待诊断推送 |
| `clangd_document_symbols` | `textDocument/documentSymbol` | 单文件符号树 |
| `clangd_workspace_symbols` | `workspace/symbol` | 全工程符号搜索（`query` 1..128 字符） |

在 DSH 里，工具全名是 `mcp__clangd-bridge__clangd_definition` 这种形式（取决于 `serverName`）。

### 公共参数

- `file`：绝对路径，或相对 `projectRoot` 的路径；必须落在 `allowedRoots` 内，扩展名必须是 C/C++ 头/源文件。
- `line` / `column`：1-based 整数；超出文件范围返回 `POSITION_OUT_OF_RANGE`，不静默 clamp。
- `limit`：1..200，默认取配置 `maxResults`（200）。

### 成功/失败信封

```json
{ "ok": true, "file": "D:/proj/a.cpp", "locations": [], "meta": { "elapsedMs": 12, "clangdPid": 1234, "truncated": false, "slow": false } }
```

```json
{ "ok": false, "code": "PATH_OUTSIDE_ALLOWED_ROOTS", "message": "路径不在允许范围内", "hint": "把该目录加入 allowedRoots，或改用 projectRoot 内的文件", "details": { "file": "C:/Windows/win.ini" } }
```

`meta.slow` 在耗时超过 5 秒时为 `true`；`meta.documentVersion` 只在文档类工具里出现。

## 安装与运行

要求：Node.js ≥ 20；一个可用的 `clangd`；目标工程有 `compile_commands.json`（CMake 加 `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`，或 `bear`/`compiledb` 生成）。

```powershell
# 1) 放到任意位置（目录名可以带空格）
# 2) 准备配置
copy clangd-bridge.example.json clangd-bridge.json
# 3) 自检
node src/server.js --config clangd-bridge.json --print-config
```

也可以直接用环境变量跑，不写配置文件：

```powershell
$env:CLANGD_PATH = "D:/Code/llvm/bin/clangd.exe"
$env:CLANGD_PROJECT_ROOT = "D:/proj/build"
node src/server.js
```

## 配置

优先级：**CLI `--config` > 环境变量 > 配置文件 > 默认值**。配置文件默认从 `cwd/clangd-bridge.json` 读，也可用 `CLANGD_BRIDGE_CONFIG` 指定。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `clangdPath` | 自动在 PATH 找 | clangd 可执行文件 |
| `projectRoot` | —（必填） | 工程根；`file` 的相对路径基准 |
| `compileCommandsDir` | `projectRoot` | `compile_commands.json` 所在目录 |
| `allowedRoots` | `[projectRoot]` | 允许读取的目录（realpath 后按分隔符边界比较） |
| `requireCompileDb` | `true` | 缺 compile db 时拒绝启动 clangd |
| `backgroundIndex` | `true` | 传 `--background-index`；关掉后跨 TU 的定义可能只返回声明 |
| `clangTidy` | `false` | 传 `--clang-tidy` |
| `queryDriver` | `null` | 需要同时把 `allowQueryDriver` 设为 `true` 才生效 |
| `startupTimeoutMs` | `30000` | LSP `initialize` 超时 |
| `requestTimeoutMs` | `30000` | 单次 LSP 请求超时 |
| `diagnosticsWaitMs` | `2000` | `clangd_diagnostics` 默认等待推送的时间（0..10000） |
| `maxResults` | `200` | 引用/符号的默认上限 |
| `maxFileBytes` | `8388608` | 单文件读取上限（8 MB） |
| `maxOpenDocuments` | `16` | 同时打开的文档数，LRU 关闭 |
| `maxRestartsPerHour` | `3` | clangd 崩溃后的重启预算（0.5s/1s/2s 退避） |
| `maxWorkspaceQueryLength` | `128` | `workspace_symbols` 的 `query` 上限 |
| `env` | `{}` | 追加给 clangd 的环境变量（仅白名单键，支持 `%VAR%` 展开） |
| `log` | `{level:"info", dir:临时目录, maxBytes:5MB, maxFiles:3}` | 日志写 stderr + 文件，绝不写 stdout |

环境变量：`CLANGD_BRIDGE_CONFIG`、`CLANGD_PATH`、`CLANGD_PROJECT_ROOT`、`CLANGD_COMPILE_COMMANDS_DIR`、`CLANGD_ALLOWED_ROOTS`（分号分隔）、`CLANGD_REQUEST_TIMEOUT_MS`、`CLANGD_LOG_LEVEL`。

`env` 只接受白名单键（`PATH`、`INCLUDE`、`LIB`、`LIBPATH`、`SYSTEMROOT`、`TEMP`、`TMP`、`USERPROFILE`、`COMSPEC`、`PATHEXT`、`CLANGD_*` 等）；其他键会被 `CONFIG_INVALID` 拒绝，避免把 API key 之类的东西塞进子进程。

## 在 DSH 里注册

本仓库**不会**自动改你的 DSH profile。把下面片段合并进对应 agent preset 的 `cordis.patch.yml`（或设置页的 MCP 配置），然后重载：

```yaml
- id: mcp-clangd-bridge
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: clangd-bridge
    transport: stdio
    command: 'C:\Program Files\nodejs\node.exe'
    args:
      - 'D:/workplace/dsh-mcp-server-clangd/src/server.js'
    env:
      CLANGD_BRIDGE_CONFIG: 'D:/workplace/dsh-mcp-server-clangd/clangd-bridge.json'
    toolCallTimeoutMs: 120000
    failOnStartupError: false
    reconnect:
      enabled: true
      initialDelayMs: 1000
      maxDelayMs: 10000
      maxAttempts: 3
```

注意：`initialize` 阶段不会启动 clangd（只做进程内检查），所以 DSH 的 stdio 探活不会因为大工程索引而超时；第一次真正查询或 `clangd_health {start:true}` 才拉起进程。

## 错误码

| 错误码 | 触发条件 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数缺失/类型错/空 query |
| `PROJECT_NOT_CONFIGURED` | 没有配置 `projectRoot`（或配置加载失败） |
| `PATH_OUTSIDE_ALLOWED_ROOTS` | 文件不在 `allowedRoots` 内 |
| `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `UNSUPPORTED_LANGUAGE` | 文件不存在/超过 8MB/非 C/C++ 扩展名 |
| `POSITION_OUT_OF_RANGE` | 行列超出文件范围 |
| `QUERY_TOO_LONG` / `LIMIT_OUT_OF_RANGE` | 超过 128 字符 / `limit` 不在 1..200 |
| `COMPILE_COMMANDS_MISSING` / `COMPILE_COMMANDS_INVALID` | compile db 缺失/JSON 或条目非法 |
| `CLANGD_NOT_FOUND` / `CLANGD_VERSION_UNSUPPORTED` | 找不到 clangd / 版本过低 |
| `CLANGD_START_FAILED` / `CLANGD_INIT_TIMEOUT` / `CLANGD_INIT_ERROR` / `CLANGD_CRASHED` | 启动与初始化失败、崩溃 |
| `LSP_REQUEST_TIMEOUT` / `LSP_ERROR` | 单次 LSP 请求超时/被 clangd 拒绝 |
| `INTERNAL_ERROR` | 未归类的内部错误 |
| `MCP_PROTOCOL_ERROR` | 协议层错误（未知方法等） |
| `CONFIG_INVALID` | 配置文件/环境变量非法（**相对前瞻规格新增的错误码**） |

## 只读保证与副作用

- 桥只发 `initialize`、`textDocument/didOpen|didChange|didClose`、`definition`、`hover`、`references`、`documentSymbol`、`workspace/symbol`、`shutdown`。
- 不发 `rename`、`formatting`、`codeAction`、`applyEdit`、`workspace/executeCommand`。
- 唯一的磁盘副作用来自 clangd 自己：在 `compileCommandsDir` 下写 `.cache/clangd/index`（`--background-index` 时）。桥不写源码、不生成 compile db。
- 日志写到临时目录（或配置的 `log.dir`）与 stderr，不污染 stdout。

## 测试与验收

```powershell
npm test          # 单元 + 集成（集成组需要 clangd，找不到时自动 skip）
npm run accept    # 场景化验收：A health / B definition / C diagnostics / D 缺 compile db / E 路径越界 …
```

`npm test` 不联网、零依赖；集成组会真实启动 clangd，约 2 秒跑完（fixture 很小）。

fixtures 的 `compile_commands.json` 不入库：测试与验收脚本会读 `compile_commands.template.json`，把 `{{CLANGXX}}`、`{{FIXTURE_DIR}}` 换成本机值后再生成。编译器默认取 `clangd-bridge.json` 里 clangd 同目录的 `clang++`，也可以用 `CLANGXX` 指定：

```powershell
$env:CLANGXX = 'D:/llvm/bin/clang++.exe'
npm test
```

> Windows 注意：某些 DSH 沙箱会拦截 Node 子进程的管道（`spawn EPERM`）。`npm test` / `npm run accept` 请在普通终端或 `danger-full-access` 下运行；这不是桥的问题。

## 已知限制（v0.1）

- 只读；没有补全、重命名、格式化、代码操作。
- `clangd_definition` 在 `backgroundIndex:false` 且没有索引时，跨翻译单元可能只返回头文件里的声明（clangd 行为，不是桥的裁剪）。
- MSVC 风格的 compile db 可以读（`compilerKind:"msvc"`），但 clangd 对 `cl.exe` 参数的理解有限，诊断可能有假阳性；`clangd_health` 会给出警告。
- 不做 `--enable-config`（避免读到用户 `.clangd` 之外的隐式行为），需要时自行在 `extraArgs` 思路之外扩展。
- 一台机器上多个 DSH 会话会各自起一个 clangd；v0.1 不做跨进程复用。

## 目录

```
src/
  server.js          MCP stdio 层（换行分隔 JSON-RPC）
  config.js          配置合并/校验/环境变量
  compileDb.js       compile_commands.json 检查
  errors.js          错误码与中文 hint
  log.js             stderr + 文件日志（轮转）
  paths.js           URI/位置/白名单/文件读取
  lsp/
    framing.js       Content-Length 分帧
    client.js        clangd 进程 + LSP 请求/通知
    documents.js     didOpen/didChange/LRU
    normalize.js     LSP 结果 → 稳定 JSON
  tools/             7 个工具的实现
tests/               unit / integration / fixtures（compile_commands 由模板生成）
scripts/accept.mjs   场景化验收
```

## License

MIT
