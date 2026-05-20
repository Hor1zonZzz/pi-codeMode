# pi-codemode-extension

`pi-codemode-extension` is a Pi package that registers a `code_mode` tool. It lets Pi write and run one JavaScript async function that can orchestrate active Pi built-in tools through a typed `codemode` object.

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
    name: "code_mode",
    // ...
  });
}
```

Pi core packages are declared as peer dependencies, following the package guidance for imports that Pi already provides:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

## Usage

Ask Pi to use `code_mode` when a task benefits from loops, branching, or multiple tool calls in one structured program.

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

## Available `codemode` Tools

`code_mode` recreates the active Pi built-in tool definitions for the current session cwd and exposes only the tools that are currently enabled:

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

- `code_mode` does not expose itself recursively.
- Arbitrary third-party extension tools are not exposed because Pi currently provides them through `pi.getAllTools()` as metadata, not executable definitions.
- If mutating tools such as `write`, `edit`, or `bash` are active in Pi, `code_mode` can orchestrate them too.

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

`pi-codemode-extension` 是一个 Pi package，会注册一个 `code_mode` 工具。它允许 Pi 写入并执行一个 JavaScript async 函数，然后通过类型化的 `codemode` 对象编排当前启用的 Pi 内置工具。

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
    name: "code_mode",
    // ...
  });
}
```

Pi 核心包按照 package 文档建议声明为 peer dependencies，因为这些导入由 Pi 运行时提供：

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

## 使用方式

当一个任务需要循环、条件分支，或者一次性组合多个工具调用时，可以让 Pi 使用 `code_mode`。

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

## 可用的 `codemode` 工具

`code_mode` 会基于当前 session 的 cwd 重新创建 Pi 内置工具定义，并且只暴露当前启用的内置工具：

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

- `code_mode` 不会递归暴露自己。
- 任意第三方 extension 工具不会被暴露，因为 Pi 目前通过 `pi.getAllTools()` 提供的是工具元数据，不是可执行定义。
- 如果 Pi 当前启用了 `write`、`edit` 或 `bash` 这类可变更工具，`code_mode` 也可以编排它们。

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
