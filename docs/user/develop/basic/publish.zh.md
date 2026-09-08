# 打包 Web 后端插件

[English](publish.md) | 中文

[插件配置教程](./config.zh.md)通过配置 patch 挂载本地插件。本参考说明如何通过包向 Web 后端贡献可重用的配置层。

## 组合包清单

组合包是一个 npm 包，其 `package.json` 在 `dsh.bundle.patch` 下声明 patch 文件：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Patch 文件使用能够从已安装包解析的名称插入插件行：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

没有 `dsh.bundle.patch` 的库不贡献配置层。消费方将其作为依赖导入。

## Web profile 配置

后端使用 `$DSH_HOME/profiles/web`。其 `package.json` 拥有外部依赖与有序的 `dsh.profile.bundles` 列表。仅安装依赖不会将其加入列表。添加外部层时应保留内置基础与 Web 应用组合包。

部署维护者通过包管理器安装外部依赖，将组合包名称加入 profile 清单，并在依赖变化后重启后端。后端不提供插件安装命令。[后端参考](../../../../apps/server/README.zh.md)定义启动与配置选项。

## 层顺序

后端按以下顺序应用配置：

1. Web profile 清单中依次列出的组合包。
2. Profile 的 `cordis.patch.yml`。
3. Harness home 的 `cordis.patch.yml`。
4. 按参数顺序列出的各个 `--patch` overlay。

Patch 替换条目的整个 `config` 值。覆盖条目时应重新声明所有必需字段。用户 patch 可以覆盖组合包的条目，而无需编辑其包。

## 分发

分发构建后的 JavaScript 与声明的 patch 文件。TypeScript 源码包必须先构建，后端才能加载其 JavaScript 入口。依赖安装脚本以安装者权限执行；部署维护者控制包管理器允许执行哪些脚本。

## 后续步骤

- [插件与生命周期](../framework/index.zh.md)
- [后端配置](../../../../apps/server/README.zh.md)
