# dsh-awsome-plugins

一组有趣的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）小插件。
不涉及任何 GUI/桌面壳实现——所有插件都跑在 dsh 默认的 Web UI（`dsh web`）里。

## 插件列表

| 插件 | 说明 |
|---|---|
| [dsh-annotations](packages/dsh-annotations) | 选中聊天消息文本 "Add to chat"：源消息保留编号下划线摘录，composer 上方的注解 dock 可增删，发送时注解随消息序列化，已发送消息渲染为可折叠摘要 |

## 使用

插件安装进 profile，然后在该 profile 的用户补丁层启用对应的行：

```bash
dsh plugin --profile web add <plugin-name>
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: annotations
      name: dsh-annotations
```

重启 `dsh web` 生效。想临时试用而不改 profile，可用一次性 overlay：

```bash
dsh --profile web --patch ./try.patch.yml
```

（`try.patch.yml` 里放同样的 insert 行。）

### 从本仓库安装到 DSH Desktop（本地包）

`dsh plugin` 是 pnpm 的转发器（在 profile 目录里执行 `pnpm add <spec>`），
所以**未发布到 npm registry 的本地包必须用 `file:`/`link:` 路径 spec 安装**，
裸包名会去 registry 拉取并 404 失败：

```bash
dsh plugin --profile web add "file:C:\WorkSpace\dsh-desktop\packages\dsh-annotations"
```

随后同样在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加 insert 行（见上），
并重启 DSH Desktop / `dsh web`。装的是 `file:` 引用，改源码后重启即生效。
安装时会出现 `declares no dsh.bundle` 的 warning——预期行为：该插件声明的是
`dsh.client`（前端插件）而非 bundle，走 patch insert 启用，不进 bundles 层。

> **`dsh` 不在 PATH 时**：DSH Desktop 自带 CLI 位于
> `"C:\Users\dunext\AppData\Local\Programs\DSH Desktop\resources\dsh-runtime\node_modules\.bin\dsh"`，
> 可将其加入用户级 PATH（`$env:Path` → 环境变量 → 用户变量 `Path`），
> 或用完整路径调用（Windows 下 `.bin\dsh.CMD`）。

## 插件的形态

每个包都是一个标准的 `dsh.client` 双面插件：

- `package.json` 声明 `dsh.client.platform: web` 和 `exports["./client"]`；
- `lib/index.js` 是 node 半边（纯 UI 插件时为空的 Cordis plugin body）；
- `lib/client.js` 是浏览器半边，`window.__ModuleLoader__.load({ id, factory })`
  工厂格式，`id` 必须等于包名——`@deepseek-ai/dsh-client-modules` 扫描 loader
  行、把插件写进 `window.__DSH_BOOT__` 并在 `/plugins/<name>/client.js` 提供该文件。

插件针对 `@deepseek-ai/dsh@0.1.1-rc.2`（根目录 devDependencies 的 pin 版本）开发与测试；
Harness 升级后请重跑冒烟测试确认。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm run check   # 校验每个插件的声明契约与两半的 JS 语法
pnpm run smoke   # 启动 pin 版 dsh web，逐个断言插件出现在 __DSH_BOOT__ 且 bundle 可访问
```

冒烟测试把所有包 staging 进临时 `$DSH_HOME` 的 `profiles/node_modules`，
用 `--patch` overlay 插入 roster 行启动 `dsh --profile web`，与真实安装同构。

## License

MIT
