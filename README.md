# dsh-awsome-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web UI 的主插件，
本身是一个标准的 `dsh.client` 双面插件，内部按**能力（feature）**组织、支持后续拓展。
首个能力是 **Add to chat**；后续新增的功能均作为新 feature 注册进同一个 bundle，
无需改动插件装载协议。

## 插件的能力

插件现在与未来提供的能力（feature）列表：

| 能力 | 说明 |
|---|---|
| Add to chat | 选中聊天消息文本 "Add to chat"：源消息保留编号下划线摘录，composer 上方的注解 dock 可增删，发送时注解随消息序列化，已发送消息渲染为可折叠摘要 |

## 使用

插件安装进 profile，然后在该 profile 的用户补丁层启用对应的行：

```bash
dsh plugin --profile web add <plugin-name>
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: awsome-plugin
      name: dsh-awsome-plugin
```

重启 `dsh web` 生效。想临时试用而不改 profile，可用一次性 overlay：

```bash
dsh --profile web --patch ./try.patch.yml
```

（`try.patch.yml` 里放同样的 insert 行。）

### 从本仓库安装到 DSH Desktop（本地包）

`dsh plugin` 是 pnpm 的转发器（在 profile 目录里执行 `pnpm add <spec>`），
所以**未发布到 npm registry 的本地包必须用 `file:`/`link:` 路径 spec 安装**，
裸包名会去 registry 拉取并 404 失败。整个仓库就是这一个插件，直接指向仓库根：

```bash
dsh plugin --profile web add "file:C:\WorkSpace\dsh-desktop"
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

`dsh-awsome-plugin` 是一个标准的 `dsh.client` 双面插件：

- `package.json` 声明 `dsh.client.platform: web` 和 `exports["./client"]`；
- `lib/index.js` 是 node 半边（纯 UI 插件时为空的 Cordis plugin body）；
- `lib/client.js` 是浏览器半边，`window.__ModuleLoader__.load({ id, factory })`
  工厂格式，`id` 必须等于包名（`dsh-awsome-plugin`）——`@deepseek-ai/dsh-client-modules`
  扫描 loader 行、把插件写进 `window.__DSH_BOOT__` 并在 `/plugins/<name>/client.js`
  提供该文件。

### 能力（feature）如何组织与拓展

`lib/client.js` 内部维护一个 feature 注册表：

- 每个能力是一个 `{ id, name, apply }` 对象；
- 用 `registerFeature(...)` 把它注册进 `features` 数组；
- 插件自身的 `apply()` 遍历注册表并逐个挂载（`DOMContentLoaded` 后），
  单个 feature 抛错只会被记录，不影响其余 feature。

新增能力 = 实现一个 feature 并 `registerFeature(...)`，无需改动装载协议或 `package.json`。

插件针对 `@deepseek-ai/dsh@0.1.1-rc.2`（根目录 devDependencies 的 pin 版本）开发与测试；
Harness 升级后请重跑冒烟测试确认。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm run check   # 校验插件的声明契约与两半的 JS 语法
pnpm run smoke   # 启动 pin 版 dsh web，断言插件出现在 __DSH_BOOT__ 且 bundle 可访问
```

冒烟测试把插件的两半 staging 进临时 `$DSH_HOME` 的 `profiles/node_modules`，
用 `--patch` overlay 插入 roster 行启动 `dsh --profile web`，与真实安装同构。

## License

MIT
