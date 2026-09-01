# dsh-annotations

DeepSeek Harness Web UI 插件：选中聊天消息里的文本，**Add to chat** 附加可选评论，
随下一条消息一起发送。

- 源消息上保留编号下划线摘录，引用锚定在原处；
- composer 上方的注解 dock 展示待发送的注解，可展开、逐条删除；
- 发送时注解序列化进消息（`<dsh_annotations version="1">` 信封），
  已发送气泡渲染为可折叠摘要而不是裸的 wire 文本。

浏览器半边目前通过 Web UI 的 DOM（`data-chat-flow`、`data-composer-card` 等）
定位聊天流和 composer，属于 pin 版本软件：针对 `@deepseek-ai/dsh@0.1.1-rc.2`
开发与冒烟验证，升级 Harness 后需要重新确认。

安装与启用方式见[仓库根 README](../../README.md)。
