# dsh-awsome-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web UI 主插件。标准 `dsh.client` 双面插件，内部按 **feature** 组织：新能力注册进同一个 bundle，不必改装载协议。

当前能力：**Quick Reference**、**Model Capabilities**、**Archived chats**、**Open in Explorer**、**System fonts**。

## 能力

| 能力 | 说明 |
|---|---|
| Quick Reference | 选中聊天消息文本后加入参考。源消息保留编号下划线摘录；composer 上方 dock 可增删注解；发送时随消息序列化；已发送消息渲染为可折叠摘要。 |
| Model Capabilities | 在 pi-ai 模型条目的展开区配置图片输入、推理等级，以及系统提示词角色。自定义网关启用推理时默认使用 `system` 而非 OpenAI 的 `developer`，避免上游 1214「角色信息不正确」。配置随提供方“保存”一起写入。 |
| Archived chats | 设置中新增归档栏目（中文「归档会话」、英文「Archived chats」，跟随 DSH 语言）。可搜索、恢复、逐条清理或清理全部。清理会永久删除本地 JSONL 会话数据，并带二次确认和运行状态保护。 |
| Open in Explorer | 会话菜单增加打开工作目录：中文「在资源管理器中打开」、英文「Open in Explorer」，跟随 DSH 语言。 |
| System fonts | 设置 → 通用 中选择本机字体和字号，分别作用于界面与代码。选择写入 `$DSH_HOME/dsh-awsome-plugin-fonts.json`，强制覆盖 `font-family`，字号以页面 zoom 缩放（因界面大量使用 px）。文案跟随 DSH 语言。 |

归档是可恢复的隐藏操作；只有进入设置里的归档栏目后主动选择“清理”，
才会永久删除本地会话数据。运行中的会话不会被清理。

## 安装

把插件装进 web profile，再在用户补丁层启用，然后重启 `dsh web` / DSH Desktop。

```bash
dsh plugin --profile web add <plugin-name>
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: awsome-plugin
      name: dsh-awsome-plugin
```

不改 profile、只想临时试用：

```bash
dsh --profile web --patch ./try.patch.yml
```

`try.patch.yml` 放同样的 insert 行即可。

### 从本仓库安装（本地包）

`dsh plugin` 会在 profile 目录执行 `pnpm add <spec>`。未发布到 npm 时必须用 `file:` / `link:` 路径；裸包名会去 registry 拉取并 404。整个仓库就是这一个插件，指向仓库根：

```bash
dsh plugin --profile web add "file:<repo-root>"
```

随后同样追加 insert 行并重启。`file:` 引用下改源码后重启即生效。

安装时可能出现 `declares no dsh.bundle`——预期行为：本插件声明的是 `dsh.client`，靠 patch insert 启用，不进 bundles 层。

> **`dsh` 不在 PATH 时**：DSH Desktop 自带 CLI 位于安装目录
> `resources/dsh-runtime/node_modules/.bin/dsh`（Windows 下为 `dsh.CMD`）。
> 加入用户 PATH，或用完整路径调用。

## 形态

- `package.json`：`dsh.client.platform: web`，以及 `exports["./client"]`
- `lib/index.js`：node 半边，提供归档恢复与本地会话安全清理端点
- `lib/client.js`：浏览器半边，`window.__ModuleLoader__.load({ id, factory })`
  `id` 必须等于包名 `dsh-awsome-plugin`

`@deepseek-ai/dsh-client-modules` 扫描 loader 行，把插件写入 `window.__DSH_BOOT__`，并在 `/plugins/<name>/client.js` 提供该文件。

### 拓展 feature

`lib/client.js` 维护注册表：每个能力是 `{ id, name, apply }`，经 `registerFeature(...)` 加入。插件 `apply()` 在 `DOMContentLoaded` 后逐个挂载；单个 feature 抛错只记日志，不影响其余。

新增能力 = 实现 feature 并注册，无需改 `package.json` 或装载协议。

针对 `@deepseek-ai/dsh@0.1.1-rc.2` 开发与测试；Harness 升级后请重跑冒烟。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm run check   # 声明契约 + 两半 JS 语法
pnpm run test:delete-session # 临时目录内验证归档恢复、清理和运行中保护
pnpm run smoke   # pin 版 dsh web：插件进 __DSH_BOOT__ 且 bundle 可访问
```

冒烟测试把两半 staging 进临时 `$DSH_HOME` 的 `profiles/node_modules`，用 `--patch` overlay 插入 roster 后启动 `dsh --profile web`，与真实安装同构。

## License

MIT
