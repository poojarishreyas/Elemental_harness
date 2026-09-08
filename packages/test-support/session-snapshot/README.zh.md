---
description: "用于浏览器测试的会话夹具、清单、规范化和工作区检查。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-snapshot

[English](README.md) | 中文

## 概述

本包为 Web 浏览器测试框架提供纯辅助函数：清单解析、标识符脱敏、会话规范化、提示词与工具 schema 快照、夹具刷新以及工作区比较。浏览器测试框架负责后端启动和用户交互；内部基础驱动保留核心会话的重放覆盖。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

从包入口导入辅助函数。[Web 测试框架](../../../apps/web/tests/scaffold.ts) 对采集的会话进行规范化，并比较提示词、工具 schema 和工作区证据。快照清单选择 Web 浏览器控制器或内部 `test-base` 控制器；无效字段或不支持的控制器会导致解析失败。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>开发者参考</summary>

| 模块 | 职责 |
|---|---|
| [manifest.ts](src/manifest.ts) | 验证场景清单 |
| [identity.ts](src/identity.ts) | 脱敏带类型的会话标识符 |
| [normalize.ts](src/normalize.ts) | 规范化会话中的易变字段 |
| [suite.ts](src/suite.ts) | 格式化提示词/schema 快照并稳定夹具刷新 |
| [workspace.ts](src/workspace.ts) | 捕获最终文件系统状态 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [llm-replay](../llm-replay/README.zh.md) — 重放录制的模型响应。
- [测试政策](../../../docs/testing.zh.md) — 证据和夹具归属。
- [测试支持组导航](../README.zh.md) — 相关测试辅助包。

-----

<a id="model-experience"></a>
## Model Experience

无，因为这些仅用于测试的辅助函数只规范化录制的会话，不改变组装后的模型请求。

#### KV Cache effect

无；本包既不组装也不发送提供者请求。

## Known Limitations and Deferred Work

- 规范化需要所属会话的标识符和工作目录。复用其他会话的上下文可能隐藏有意义的差异，或保留易变字段。

<a id="dev-note"></a>
### 开发备注

无。
