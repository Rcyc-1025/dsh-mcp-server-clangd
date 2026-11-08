# 验收记录（v0.1.0）

- 日期：2026-11-07
- 环境：Windows、Node.js v24.18.0、clangd 23.1.4（`D:\Code\llvm\clang+llvm-23.1.4-x86_64-pc-windows-msvc\bin\clangd.exe`）
- 真实工程：`D:\Code\llvm-build\compile_commands.json`（3741 条，`compilerKind=msvc`）
- fixture：`tests/fixtures/hello`、`tests/fixtures/broken`（clang++ 23.1.4，`backgroundIndex:true`）

## 怎么跑

```powershell
# 单元 + 集成（集成本机找不到 clangd 时自动 skip）
npm test

# 场景化验收（真实 clangd；A 用根目录 clangd-bridge.json，其余用临时配置 + fixtures）
npm run accept
```

> 在带 DSH 文件沙箱的会话里，Node `spawn` 的管道可能被拦成 `EPERM`。验收和集成测试需要在普通终端、或 `danger-full-access` 模式下运行。

## 结果汇总

`npm test`：**57 项（40 单元 + 17 集成）全部 PASS**（约 2 秒）。

`npm run accept`：**20/20 PASS**，明细如下。

| 项 | 场景 | 期望 | 实测 |
| --- | --- | --- | --- |
| A1 | `clangd_health` 静态检查 | `state=not_started`、不 spawn、`entries=3741`、`<1000ms` | `ms=43`，`entries=3741`，`compiler=msvc` |
| A1b | MSVC compile db 警告 | 至少 1 条 warning | `warnings=1`（clangd 对 `cl.exe` 参数理解有限） |
| A2 | `clangd_health {start:true}` | `state=ready`、有 pid | `pid=22444`，`clangd version 23.1.4`，约 80ms |
| MCP1 | `tools/list` | 7 个工具 | 7 个，名称与顺序符合规格 |
| B | `definition main.cpp:3:10` | `foo.cpp:2:5` | `foo.cpp:2:5`（30s 轮询内命中，实际 <1s） |
| F1 | `hover main.cpp:3:10` | 非空、含 `foo` | markdown 签名 + 参数 |
| F2 | `references foo.cpp:2:5` | ≥2 | `total=3`（含 `foo.h:2:5` 声明） |
| F3 | `document_symbols main.cpp` | 1 个 `main` | `total=1`，`kind=function` |
| F4 | `workspace_symbols query=foo` | 命中 `foo` | `total=1` |
| F5 | 干净文件 `diagnostics` | `pending=false`、0 条 | `total=0` |
| F9 | 5 个列表工具的顶层 `truncated`、`references.locations` | 均为布尔且与 `meta.truncated` 一致；无旧字段 `references` | `ok` |
| F10 | `health.checks` 含 `log.dir` / `queryDriver` | 两项都在 | 8 个 check 全在 |
| E | `definition C:/Windows/win.ini` | `PATH_OUTSIDE_ALLOWED_ROOTS` | 同左（`isError=false`） |
| F6 | `line=9999` | `POSITION_OUT_OF_RANGE` | 同左（不 clamp） |
| F7 | `workspace_symbols query="  "` | `INVALID_ARGUMENT` | 同左 |
| F8 | 未知工具 | 协议错误 `-32602` | 同左 |
| C | `broken/main.cpp` 诊断 | `severity=error`、含 `missing_symbol`、`line=2`(1-based)、`pending=false` | `line=2 col=10`，`code=undeclared_var_use` |
| D | 无 compile db 时 `health {start:true}` | `COMPILE_COMMANDS_MISSING`、`<500ms`、不 spawn | `ms=24` |
| G1 | 损坏的 compile db | `COMPILE_COMMANDS_INVALID` | 同左（启动前失败） |
| G2 | 错误的 clangd 路径 | `CLANGD_NOT_FOUND` | 同左 |

## 关键行为说明

### 位置约定

所有返回位置都是 1-based；`end` 为 exclusive。例如 `foo.cpp` 第 2 行 `int foo(int x) { ... }` 的定义名返回：

```json
{ "start": { "line": 2, "column": 5 }, "end": { "line": 2, "column": 8 } }
```

列是 UTF-16 码元偏移（与 LSP 一致），`end.column - start.column` 等于名称长度（这里是 3）。

### B 场景与 background-index

同一份 fixture，`backgroundIndex:false` 时 `definition` 返回 `foo.h:2:5`（声明），因为 clangd 尚未索引另一个翻译单元里的定义；打开 `backgroundIndex:true` 后约 0.5 秒返回 `foo.cpp:2:5`。验收脚本用 30 秒轮询兜底，实测第一次命中即通过。

### D 场景为什么必须快

桥在 `assertCompileDb` 阶段同步检查 `compile_commands.json`，缺失/损坏时直接返回结构化错误，**不 spawn clangd**。因此耗时为毫秒级，且 `health` 响应里没有 `process.pid`。

### 诊断的 pending 语义

`clangd_diagnostics` 打开文档后等待 `publishDiagnostics`（默认 2000ms，可传 `waitMs` 0..10000）。若超时，返回 `pending:true` + 当前缓存，并在 `note` 里说明；调用方可以加大 `waitMs` 重试，而不是把“还没推送”误判成“没有错误”。

### 诊断缓存与重启同步（审查修复）

- 首次 `didOpen` 与内容变化 `didChange` **之前**清空该 URI 的旧诊断；只有 mtime/size 未变时才复用缓存。这样 `pending:false` 只可能对应“本版本的诊断已到”。
- `LspClient` 退出/重启时 `clearAllDiagnostics()`：清诊断与 waiter，等待方立即得到 `pending:true`，不会挂到超时。
- `DocumentStore` 订阅 `client.on('exit')` → `forgetAll()`：丢弃文档记录（不发 `didClose`），下次 `ensure` 重新 `didOpen` 且版本重置为 1。否则 clangd 崩溃重启后会误以为旧文档仍打开而跳过 `didOpen`。

### queryDriver 与 log.dir 的收口（审查修复）

- `queryDriver` 只在 `allowQueryDriver:true` 时生效，且 `;` 分隔的每一项（glob 取静态前缀）`realpath` 后必须位于 `allowedRoots` 内；不满足时配置层直接禁用 + 警告，`buildArgs()` 二次校验并抛 `CONFIG_INVALID`，`health.checks` 给出 `queryDriver` 结论。
- `log.dir` 必须在 `projectRoot` 或系统临时目录内；越界时回落到 `<tmp>/dsh-clangd-bridge/logs` 并写 warning，`health.checks` 的 `log.dir` 同时复核。

### 同步 schema 修正（审查修复）

- `clangd_references` 顶层输出 `locations`（规格 §7.4），不再输出 `references`。
- `definition` / `references` / `diagnostics` / `document_symbols` / `workspace_symbols` 的 `truncated` 同时出现在顶层与 `meta.truncated`（规格 §6.3 / §7.2 / §7.6 / §7.7），两者恒等。

## 真实 LLVM 冒烟（只记录，不作为门禁）

配置：`clangd-bridge.json`（`projectRoot=compileCommandsDir=D:/Code/llvm-build`，`allowedRoots` 含 `D:/Code/llvm-build`、`D:/Code/llvm`、`D:/Code/llvm-src`，`backgroundIndex:true`）。

对象：`D:/Code/llvm-src/llvm-project-23.1.4.src/llvm/lib/Demangle/Demangle.cpp`。

| 操作 | 结果 |
| --- | --- |
| `health {start:true}` | `ready`，`entries=3741`，87ms |
| `document_symbols`（limit 50） | `total=6`、`hierarchical=true`，469ms（含首次 parse） |
| `hover`（第一个符号 `starts_with`，line 19 col 31） | 非空，20ms，`### using starts_with` |
| `definition`（同一位置） | 2 个位置，14ms，指向 `llvm/include/llvm/Demangle/StringViewExtras.h:28` |

说明：大工程首次索引会持续写 `.cache/clangd/index`，这是 clangd 自身行为；桥只读源码。

## 回归清单（改代码后重跑）

1. `npm test` —— 57 项（40 单元 + 17 集成）；
2. `npm run accept` —— 20 项全 PASS；
3. 改动 `client.js` 启动/重启逻辑时，额外确认 `health` 里 `restarts` 在首次启动后仍为 0、崩溃重启后才递增；
4. 改动 `normalize.js` 时，重点看 `document_symbols` 的截断是否仍保持树结构（子节点不重复进扁平列表）。
