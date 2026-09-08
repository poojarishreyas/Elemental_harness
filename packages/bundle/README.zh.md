---
description: "Web 后端的共享核心与浏览器应用配置组合包。"
kind: "package-group"
---

# bundle/：profile 插件组合包

[English](README.md) | 中文

## 概述

本组列出 Web 后端使用的配置层。每个组合包声明 `dsh.bundle.patch`；服务器依次应用 `dsh-base` 与 `dsh-web-app`，然后应用用户配置 patch。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`base`](base/README.zh.md) | 基于 base 的 profile 共享核心 | —（仅 patch） |
| [`web-app`](web-app/README.zh.md) | 基于 base 的浏览器应用层 | 挂载 Web 配置项 |

内置组合包从后端安装目录解析。外部插件的依赖与有序组合包列表由 Web profile 清单声明。

<a id="related-documentation"></a>
## 相关文档

- [Web 后端](../../apps/server/README.zh.md)——浏览器应用的启动与配置。
- [app-boot](../boot/app-boot/README.zh.md)——profile 如何解析、分层与定制。
- [Profile 组合包设计笔记](../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与组合包的组合设计。


<a id="dev-note"></a>
## 开发备注

无。
