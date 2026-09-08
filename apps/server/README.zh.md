# Web 后端

[English](README.md) | 中文

本应用启动 Web GUI 的后端。它加载固定的 `web` profile、提供浏览器应用，并在共享运行时中管理智能体、工具、审批及已保存的会话。此包没有公开命令 bin。

## 运行

构建仓库产物，然后从仓库根目录启动：

```sh
pnpm run build
pnpm start
```

构建后的后端入口为 `node apps/server/lib/index.js`。配置错误、无效选项与插件启动失败均非零退出。[后端参考](reference/README.zh.md)说明选项、配置层及源码执行。

<a id="profiles"></a>
## Profile

后端始终使用 `$DSH_HOME/profiles/web`。其清单记录有序组合包与外部插件依赖。内置 `dsh-base` 与 `dsh-web-app` 组合包提供共享运行时与浏览器应用。Profile patch、home patch 及有序的 `--patch` overlay 可定制该组合。

后端保留配置 patch 的实时重载。依赖或组合包成员变化需要重启。后端不提供 profile 选择或插件安装命令。

## 可选 overlay

`config/examples/` 包含 GitHub 评审 webhook、会话提醒、记忆 MCP 服务器及运行时 Cordis 工具的可选 overlay。[用户指南](../../docs/user/guide/index.zh.md)与[开发实践指南](../../docs/user/develop/practice/index.zh.md)定义配置步骤。

## 开发

[`src/index.ts`](src/index.ts)负责启动，[`src/args.ts`](src/args.ts)解析配置选项，[`src/profile-boot.ts`](src/profile-boot.ts)挂载与销毁插件树。构建前提见[源码执行](reference/README.zh.md#source-execution)。
