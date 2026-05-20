# pi-codemode-extension

`pi-codemode-extension` is a Pi package that registers an `exec` tool. Code Mode is the execution style: the tool lets Pi write and run one JavaScript async function that can orchestrate active Pi built-in tools through a typed `codemode` object.

This follows Pi's extension/package conventions: the extension is a TypeScript module, it registers an LLM-callable tool with `pi.registerTool()`, and the package exposes the extension through the `pi.extensions` manifest in `package.json`.

## Quick Start

Install dependencies for local development:

```bash
npm install
```

Try the extension for a single Pi run:

```bash
pi -e ./extensions/code-mode.ts
```

Install this directory as a Pi package:

```bash
pi install .
```

Install into project-local settings instead of user settings:

```bash
pi install . -l
```

## Uninstall

```bash
pi remove pi-codemode-extension
```

`pi remove` uninstalls the package and removes its settings entry. The persisted
`/codeMode` config is written by the extension itself and is not tracked by Pi,
so delete it manually if you want a fully clean uninstall:

```bash
rm ~/.pi/agent/codemode-extension.json
```

## Package Manifest

Pi loads this package through the `pi` manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/code-mode.ts"]
  }
}
```

The extension entrypoint exports the standard Pi extension factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codeModeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "exec",
    // ...
  });
}
```

Pi core packages are declared as peer dependencies, following the package guidance for imports that Pi already provides:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

## Usage

Ask Pi to use `exec` when a task benefits from loops, branching, or multiple tool calls in one structured program.

Example tool input:

```ts
async () => {
  const root = await codemode.ls({ path: "." });
  console.log("Root entries:", root);
  return root;
}
```

The tool returns a JSON summary containing:

- `result`: the value returned by the async function
- `logs`: captured `console.log/info/warn/error` calls
- `calls`: each `codemode.*` tool call, duration, status, and preview
- `durationMs`: total runtime
- `timedOut`: whether execution exceeded the timeout
- `error`: runtime, validation, tool, or timeout error text when present

## The `/codeMode` Command

Run `/codeMode` in an interactive Pi session to open a settings overlay. Use the
arrow keys to move and **Space** to cycle each row:

- **Code Mode** — `enabled` / `disabled`. When enabled, the built-in tools are
  hidden from the model and `exec` is exposed in their place; the model can only
  reach them indirectly through `exec`. When disabled, `exec` is hidden and the
  built-in tools Pi had at startup are restored.
- **tool: read / write / edit / bash / grep / find / ls** — `on` / `off`. Controls
  which built-in tools `exec` is allowed to orchestrate. Calling an `off` tool
  from inside `exec` fails that call with a clear error.

Changes apply immediately and persist across sessions in
`~/.pi/agent/codemode-extension.json` (alongside Pi's own config; honors
`$PI_CODING_AGENT_DIR`). On first run of each session the defaults are seeded
from the tools Pi has active at startup.

## Available `codemode` API

`exec` recreates the Pi built-in tool definitions for the current session cwd.
The API always declares every built-in tool; whether a call succeeds is governed
at runtime by the `/codeMode` configuration:

```ts
codemode.read(input);
codemode.write(input);
codemode.edit(input);
codemode.bash(input);
codemode.grep(input);
codemode.find(input);
codemode.ls(input);
```

Notes:

- `exec` does not expose itself recursively.
- `exec` executes its own copies of the built-in tool definitions, so it can
  orchestrate a tool even after that tool has been hidden from the model.
- A tool turned `off` in `/codeMode` is still listed in the API but returns an
  error when called; toggle it `on` to enable it.
- Arbitrary third-party extension tools are not exposed because Pi currently
  provides them through `pi.getAllTools()` as metadata, not executable definitions.

## Safety Model

The JavaScript runs in a Worker-backed Node.js `node:vm` context. It exposes `codemode`, a limited `console`, and JSON-safe globals. It does not directly expose `require`, `process`, filesystem APIs, or network APIs.

This is a local execution guard, not a Cloudflare Worker or `isolated-vm` security boundary. Pi extensions and Pi packages run with full local system permissions, so only install and run code you trust.

## Development

Run the TypeScript check:

```bash
npm run check
```

Runtime smoke test:

```bash
PI_OFFLINE=1 pi -e ./extensions/code-mode.ts --help
```

## References

- Pi Extensions: https://pi.dev/docs/latest/extensions
- Pi Packages: https://pi.dev/docs/latest/packages
- Cloudflare Agents Code Mode reference: https://developers.cloudflare.com/agents/api-reference/codemode/

---

# pi-codemode-extension 中文说明

`pi-codemode-extension` 是一个 Pi package，会注册一个 `exec` 工具。Code Mode 是执行模式：这个工具允许 Pi 写入并执行一个 JavaScript async 函数，然后通过类型化的 `codemode` 对象编排当前启用的 Pi 内置工具。

这个包遵循 Pi 的 extension/package 规范：扩展是 TypeScript 模块，通过 `pi.registerTool()` 注册可供模型调用的工具，并在 `package.json` 的 `pi.extensions` manifest 中声明入口文件。

## 快速开始

安装本地开发依赖：

```bash
npm install
```

只在当前 Pi 运行中临时加载扩展：

```bash
pi -e ./extensions/code-mode.ts
```

把当前目录安装为 Pi package：

```bash
pi install .
```

安装到项目级配置，而不是用户级配置：

```bash
pi install . -l
```

## 卸载

```bash
pi remove pi-codemode-extension
```

`pi remove` 会卸载这个包并删除它的 settings 条目。`/codeMode` 的持久化配置是扩展自己
写的，Pi 不会跟踪它，所以如果想彻底清理干净，需要手动删除：

```bash
rm ~/.pi/agent/codemode-extension.json
```

## Package Manifest

Pi 通过 `package.json` 里的 `pi` manifest 加载这个包：

```json
{
  "pi": {
    "extensions": ["./extensions/code-mode.ts"]
  }
}
```

扩展入口导出标准 Pi extension factory：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codeModeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "exec",
    // ...
  });
}
```

Pi 核心包按照 package 文档建议声明为 peer dependencies，因为这些导入由 Pi 运行时提供：

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

## 使用方式

当一个任务需要循环、条件分支，或者一次性组合多个工具调用时，可以让 Pi 使用 `exec`。

工具输入示例：

```ts
async () => {
  const root = await codemode.ls({ path: "." });
  console.log("Root entries:", root);
  return root;
}
```

工具会返回 JSON 摘要，包含：

- `result`：async 函数返回值
- `logs`：捕获到的 `console.log/info/warn/error`
- `calls`：每次 `codemode.*` 调用的工具名、耗时、状态和预览
- `durationMs`：总运行时间
- `timedOut`：是否超时
- `error`：运行时错误、参数校验错误、工具错误或超时错误

## `/codeMode` 命令

在交互式 Pi 会话里运行 `/codeMode` 会打开一个设置面板。用方向键移动，用**空格**切换每一行的值：

- **Code Mode** —— `enabled` / `disabled`。启用时，内置工具会从模型面前隐藏，由
  `exec` 取而代之，模型只能通过 `exec` 间接调用它们；禁用时，`exec` 被隐藏，并恢复
  Pi 启动时原有的内置工具。
- **tool: read / write / edit / bash / grep / find / ls** —— `on` / `off`，控制
  `exec` 被允许编排哪些内置工具。在 `exec` 里调用一个 `off` 的工具会让该次调用失败
  并返回明确错误。

修改即时生效，并保存在 `~/.pi/agent/codemode-extension.json` 中跨会话持久化（与 Pi
自身配置放在一起，并遵循 `$PI_CODING_AGENT_DIR`）。每个会话首次运行时，默认值会根据
Pi 启动时启用的工具来初始化。

## 可用的 `codemode` API

`exec` 会基于当前 session 的 cwd 重新创建 Pi 内置工具定义。API 始终声明全部内置工具；
某次调用是否成功，由运行时的 `/codeMode` 配置决定：

```ts
codemode.read(input);
codemode.write(input);
codemode.edit(input);
codemode.bash(input);
codemode.grep(input);
codemode.find(input);
codemode.ls(input);
```

注意：

- `exec` 不会递归暴露自己。
- `exec` 执行的是它自己复制的内置工具定义，所以即使某个工具已对模型隐藏，`exec` 仍可编排它。
- 在 `/codeMode` 里被设为 `off` 的工具仍会出现在 API 里，但调用时会返回错误；切到 `on` 才可用。
- 任意第三方 extension 工具不会被暴露，因为 Pi 目前通过 `pi.getAllTools()` 提供的是工具元数据，不是可执行定义。

## 安全模型

JavaScript 运行在 Worker 承载的 Node.js `node:vm` context 中。沙箱暴露 `codemode`、受限 `console` 和 JSON 安全的全局对象，不直接暴露 `require`、`process`、文件系统 API 或网络 API。

这只是本地执行防护，不是 Cloudflare Worker 或 `isolated-vm` 级别的安全边界。Pi extensions 和 Pi packages 拥有完整本机权限，所以只安装和运行你信任的代码。

## 开发

运行 TypeScript 检查：

```bash
npm run check
```

运行加载 smoke test：

```bash
PI_OFFLINE=1 pi -e ./extensions/code-mode.ts --help
```

## 参考

- Pi Extensions: https://pi.dev/docs/latest/extensions
- Pi Packages: https://pi.dev/docs/latest/packages
- Cloudflare Agents Code Mode reference: https://developers.cloudflare.com/agents/api-reference/codemode/
