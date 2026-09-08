# Web 后端参考

[English](README.md) | 中文

后端加载固定的 `web` profile 并提供浏览器应用。[`src/args.ts`](../src/args.ts)定义配置选项；[Web 启动插件](../../../packages/bundle/web-app/src/startup.ts)定义 HTTP 选项。

<a id="profiles"></a>
## Profile 启动

后端在需要时通过随附模板初始化 `$DSH_HOME/profiles/web`。Profile 包含依赖清单与 `cordis.patch.yml`。配置按以下顺序应用于空根：

1. 按 `dsh.profile.bundles` 顺序应用组合包 patch：内置基础与 Web 应用层，然后是配置的外部组合包。
2. Web profile 的 `cordis.patch.yml`。
3. Home 级 `$DSH_HOME/cordis.patch.yml`。
4. 按参数顺序应用各个 `--patch` overlay。

后面的层替换目标行的整个 `config` 值或插入行。`patchReload: live` 监视 profile 与 home patch 文件。运行进程的组合包成员固定；依赖或清单变化后应重启。内置组合包从后端安装目录解析，外部组合包从 profile 依赖解析。

## 选项

| 选项 | 行为 |
|---|---|
| `--patch <path>` | 应用额外配置 overlay；可重复以形成有序层。 |
| `--dump-config` | 输出有效配置，不启动 HTTP 服务。 |
| `--dump-default-config` | 输出组合包配置，不包含用户 patch。 |
| `--host <host>` | 覆盖 HTTP 绑定主机；拒绝 `0.0.0.0`。 |
| `--port <port>` | 覆盖监听端口；`0` 选择空闲端口。 |
| `--trusted-host <authority>` | 增加浏览器 API 信任检查接受的 authority。 |
| `--no-open` | 启动时不打开默认浏览器。 |
| `--help` | 显示 Web 启动选项。 |
| `--version` | 输出应用版本。 |

两个 dump 选项互斥，且不接受 HTTP 选项。`--dump-default-config` 同时拒绝 `--patch`。后端拒绝 `--profile` 及独立任务或插件命令。配置、schema、解析与插件失败均非零退出。

## 浏览器与关闭

内置配置监听 `http://127.0.0.1:3080`。本地启动在插件树稳定后打开浏览器，除非指定 `--no-open`。SSH 启动只输出主机 URL，不打开浏览器。浏览器交接失败时服务器继续运行并报告 URL。

SIGINT 与 SIGTERM 在退出前销毁挂载的插件树。第二次信号强制退出；有时限的关闭流程处理未完成销毁的插件。[启动包](../../../packages/boot/app-boot/README.zh.md)定义关闭行为。

## 部署配置

启动目录提供默认文件系统位置；用户在浏览器中选择工作区。模型、工具、设置、凭据、权限策略与持久化通过[基础组合包](../../../packages/bundle/base/README.zh.md)及 [Web 应用组合包](../../../packages/bundle/web-app/README.zh.md)配置。Shell 执行是智能体能力，可通过浏览器任务使用。

外部依赖由部署的包管理器安装。Profile 清单必须在 `dsh.profile.bundles` 中列出组合包，才能激活其 patch 层；仅安装依赖不会激活。后端不提供包管理命令。[插件打包](../../../docs/user/develop/basic/publish.zh.md)说明这些清单。

<a id="source-execution"></a>
## 源码执行

`pnpm run build` 准备包与浏览器产物。`pnpm start` 调用 `node --import tsx/esm apps/server/src/index.ts`，不会重新构建。源码入口仍需要生成的 Host 产物与浏览器 bundle；修改后应重新构建。构建后的入口为 `node apps/server/lib/index.js`。

进程继承启动环境，并加载 Harness home 与工作目录的环境层。[开发指南](../../../docs/development.zh.md)定义贡献者设置，[app-boot](../../../packages/boot/app-boot/README.zh.md)定义 home 与环境解析。
