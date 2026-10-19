# 发布到 npm

包名为 `@nothingzhl/jev-mcp`，初始版本为 `0.1.0`，目标 registry 为 `https://registry.npmjs.org/`，访问级别为 public。未加 scope 的 `jev-mcp` 在准备时已有其他发布记录，不能假定属于本仓库。npm 账号必须拥有 `nothingzhl` 用户或组织 scope 的发布权限；GitHub 用户名相同不代表自动拥有权限。

代码采用 Apache-2.0，完整条款见根目录 LICENSE。package.json 和 package-lock.json 已同步许可证标识；发布包会自动包含 LICENSE。

## 本地验证

在源码目录使用 Node.js 24（最低 22.16）：

```sh
npm ci
npm run release:check
npm run pack:local
```

`release:check` 执行 `npm publish --dry-run`，会触发发布前的类型检查、全部离线测试、构建及 demo，再预览打包内容，不上传包、不要求 npm 登录。`prepack` 会再次构建，确保 dist 对应当前源码。测试和 demo 不调用真实模型。

`files` 白名单只交付 dist、README、接入/发布说明及三个合成输入和配置示例；检查输出中没有凭证、数据库或私有材料。npm 会自动纳入 package.json 和存在的 LICENSE 文件。源码开发脚本仍在 package.json 中，但发布包直接运行编译后的 `jev` / `jev-mcp`，不支持 `npm run setup:codex` 等源码开发命令。

scope 会改变本地包文件名。当前产物为 `.data/nothingzhl-jev-mcp-0.1.0.tgz`。可用隔离配置检查编译入口：

```sh
npm exec --yes --package ./.data/nothingzhl-jev-mcp-0.1.0.tgz -- jev recipes
npm exec --yes --package ./.data/nothingzhl-jev-mcp-0.1.0.tgz -- jev install-codex --config /tmp/jev-release-check/config.toml --dry-run
```

第二条只预览注册，不写配置。更新相同版本的本地 tarball 时，npm exec 可能复用缓存；验证新产物应复制到新的临时路径后再安装。

## 首次发布

维护者在可信终端中操作：

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish
```

发布会再次执行离线检查和构建。按 npm 提示完成账号认证与双因素验证，不把密码、验证码或 token 写入仓库、聊天或示例。`npm publish` 会实际公开上传包；本项目的修改、dry run 和本地打包均不代表已经发布。registry 的 E404 也不能证明当前账号有某个 scope 的发布权限。

确认发布结果：

```sh
npm view @nothingzhl/jev-mcp@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
```

发布成功后，用户在运行 Codex 的机器执行：

```sh
npx --yes --package @nothingzhl/jev-mcp@0.1.0 jev install-codex
```

注册命令会写入 Codex 配置；支持 `--dry-run` 预览或 `--config` 指定目标。凭证配置与首次 dry run 见 [Codex 接入指南](codex-quickstart.md)。明确写出 `--package` 和 `jev`，避免 npx 选择直接启动 MCP 的另一个 bin。

## 配置 GitHub 自动发布

仓库提供 [.github/workflows/publish.yml](../.github/workflows/publish.yml)，推送 `v*` 标签时自动发布。只允许 `nothingzhl/jev-mcp` 仓库，使用 GitHub 托管的 Ubuntu、Node.js 24、npm 11.9.0 和 OIDC；无需添加 NPM_TOKEN 或 NODE_AUTH_TOKEN secret。checkout/setup-node 固定到已核对的 v7 commit。

首次手动发布后，在 npm 的 `@nothingzhl/jev-mcp` 包页面打开 **Settings → Trusted Publisher**，选择 GitHub Actions，填写：

| 字段 | 值 |
| --- | --- |
| Organization or user | `nothingzhl` |
| Repository | `jev-mcp` |
| Workflow filename | `publish.yml`（只填文件名，含扩展名） |
| Environment name | 留空，当前工作流未使用 GitHub Environment |

若界面提供 Allowed actions，允许 `npm publish`。新建的可信发布配置须在两天内完成首次成功发布，否则按 npm 文档删除过期配置后重建。GitHub 账号和 npm 账号通过各自权限管理，这里的仓库 owner 字段指 GitHub owner。

先把所有代码、LICENSE、包元数据及工作流提交并推送到远端；tag 必须指向包含这些文件的提交。第一次手动发布 `0.1.0` 后，自动发布从 `0.1.1` 等新版本开始，不再推送 `v0.1.0` 尝试覆盖。

## 后续版本：推标签自动发布

每次发布使用新版本号，已经发布的相同版本不可覆盖：

```sh
npm version patch
git push origin HEAD
git push origin "$(git describe --tags --exact-match HEAD)"
```

`npm version patch` 在干净 Git 工作区默认同步 package.json/package-lock.json，创建版本提交和 `v<版本>` tag。执行前先提交要发布的改动并审查版本；`git push origin HEAD` 按仓库分支规则操作。最后一条只推送刚生成的当前 tag，不推送所有历史标签。推送 tag 会真实触发 npm 公开发布，可在 GitHub Actions 的 **Publish to npm** 查看结果；不会创建 GitHub Release。

工作流在安装依赖前验证包名、tag、两个锁文件版本字段及公开 registry 配置。仅支持稳定版本（例如 `v0.1.1`），预发布版本会停止，避免意外覆盖 latest。发布命令通过 prepublishOnly 运行类型检查、全部离线测试、构建和 demo；任一步失败即停止，prepack 再构建 dist。并发的同名 tag 任务排队执行；已发布版本不能覆盖，重复运行可能因版本已存在而失败，不要删 tag 后重发同一版本。

`id-token: write` 用于向 npm 证明 GitHub 工作流身份，不需要长期 npm 写入 token。公开仓库发布公开包时，npm 自动附带 provenance；不满足公开仓库条件时不保证生成来源证明。不要在此工作流加入真实 TYPESAFE_API_KEY：验证均为离线，模型请求预算不随发布更新。

可信发布配置错误时，先核对 owner、repo、文件名、GitHub 托管 runner 和 npm 版本。通过本地 dry run 不代表已经验证 GitHub OIDC；首次远端运行成功后才能确认自动发布通路。官方依据：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
