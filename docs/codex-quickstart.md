# 在 Codex 中使用 Jev

先在运行 MCP 服务的目标机器检出本仓库，使用 Node.js 24（最低 22.16）。本地 stdio 配置里的路径必须能被该机器访问；当前云任务的 `/workspace/...` 路径不能直接用于另一台桌面机器。

## 生成配置

在包含当前代码的源码目录中，一条命令即可安装锁定依赖、构建并注册到 Codex 用户配置：

```sh
npm run setup:codex
```

默认目标是 `~/.codex/config.toml`；若启动环境已有 CODEX_HOME，则使用该目录的 config.toml。预览步骤用 `npm run setup:codex -- --dry-run`，预览不安装依赖、不构建、不写配置。指定受信任项目配置可用 `npm run setup:codex -- --config /absolute/project/.codex/config.toml`。

安装命令仅新增 Jev 表，保留原文件字节、注释、其他服务和权限。完全相同的注册再次执行会返回 already-installed，不重写配置；同名配置不同、TOML 无效、符号链接或已有安装锁时会报错并保留原文件，不自动覆盖。多个 Jev 安装器通过文件锁协调；安装期间避免同时用其他编辑器修改同一文件。异常中断可能留下 `.jev.lock`，确认没有安装进程后再手动清理。注册成功后重新加载 Codex 并进行下文 dry run。

已构建目录或已安装的包可直接用 `jev install-codex`（源码目录中用 `node dist/cli.js install-codex`）。支持相同的 `--config` 和 `--dry-run`，不需要 Codex CLI 或 API key，也不会发模型请求。服务 cwd 设为配置所在目录，默认数据库因此位于该目录的 `.data/jev.sqlite`；已有 JEV_DB_PATH 仍可覆盖，避免把元数据库写入只读安装目录。

## 本地安装包

当前项目尚未发布到 npm。源码目录可生成只包含编译产物和接入说明的本地包：

```sh
npm run pack:local
```

产物在 `.data/jev-mcp-0.1.0.tgz`，不包含密钥、SQLite、测试或评测响应。将文件放到目标机器后，可直接安装运行注册命令：

```sh
npm exec --yes --package ./jev-mcp-0.1.0.tgz -- jev install-codex
```

这会下载运行依赖并注册该包的编译入口，无需目标机器安装 TypeScript 或手工构建。npm exec 使用缓存内的安装路径；清理或迁移缓存后需重新注册。原配置指向其他安装位置时会保留并报冲突，应先审查并移除旧 Jev 表，再重新注册。命令不会上传或发布本地包。

## 只打印配置

在仓库根目录运行：

```sh
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js mcp-config
```

`mcp-config` 输出带当前 Node、服务入口和工作目录绝对路径的 TOML。它不联网、不写数据库、不修改 Codex 设置，也不读取或输出凭证值；不要求 key，输出也不代表服务已注册。移动仓库或更换 Node 后重新生成。

将输出的 `[mcp_servers.jev]` 表合并到目标机器的 Codex 配置。官方支持用户级 `~/.codex/config.toml`，或受信任项目的 `.codex/config.toml`。保留其他 server；已有 jev 表时更新对应字段，不重复追加同名表。仓库中的 [便携样例](../examples/codex-config.toml)仍可手工替换路径。

`mcp-config` 只生成配置；只有显式运行安装/注册命令才写入选定的 Codex 配置。远程执行器的启动与环境变量来源由客户端另行配置；默认生成的本地 stdio 表使用 Codex 启动环境，不能据此认为桌面客户端已连接云服务。

## 凭证与云代理

TYPESAFE_API_KEY 经启动 Codex 的环境安全注入；生成的 env_vars 只列名字，不在 TOML 中写 key。`.env` 不会自动加载。doctor 只报告 key 是否存在，不验证账号或网络；没有 key 仍可完成下文 dry run。

配置会转发应用变量以及已有的 HTTP_PROXY、HTTPS_PROXY、NO_PROXY（含小写形式）、NODE_USE_ENV_PROXY、NODE_EXTRA_CA_CERTS、SSL_CERT_FILE、SSL_CERT_DIR、NODE_USE_SYSTEM_CA。不要把它们的值复制到聊天或配置示例中。

本云环境的 Node 24 真实网络调用需要在启动 Codex 前设置 `NODE_USE_ENV_PROXY=1`，并保留平台注入的代理和 CA 变量。配置生成器只转发该开关，不自动设置或改变信任。最低支持的 Node 22.16 不包含这项代理能力保证；需要此代理路径时使用 Node 24。没有代理需求的目标机器按自身环境配置。

## 第一次调用：只验证接入

重新加载 Codex 的配置后，用 `/mcp` 查看活动服务和工具。预期 jev 下有：

- jev_rank_candidates
- jev_verify_claims
- jev_triage_failure
- jev_run_recipe

可以给 Codex 这条指令：

> 只调用 jev_run_recipe 一次，recipeId 设为 rank-candidates，dryRun 必须为 true；input 使用下方合成材料。展示规则版本和问题数量，不进行真实模型调用。

```json
{
  "recipeId": "rank-candidates",
  "input": {
    "task": "查找生成离线检查命令的材料",
    "candidates": [
      { "id": "guide", "title": "开发说明", "content": "运行 npm run check 执行离线类型检查、测试和构建。" },
      { "id": "theme", "title": "样式说明", "content": "按钮使用蓝色。" }
    ]
  },
  "dryRun": true
}
```

验收结果是 dryRun=true、recipeVersion=1.2.0、两个 Score 问题的请求计划；没有模型分数或实际模型信息，也没有新调用记录。工具可列出和 dry run 通过分别验证发现与执行通路，不能声称已获得模型判断。三个专用工具以及 generic 的默认 dryRun=false 都会真实调用。

## 开始实际任务

项目级 [jev skill](../.agents/skills/jev/SKILL.md)给出最少材料与结果解读。调查材料用排序、完成声明用证据核对、已经发生的失败用归类；调用时只传与任务有关的片段。真实调用需要已有覆盖本次材料和用量的授权；前两批评测预算已耗尽，不能自动沿用。

保留 review、unknown 和原始置信信息。排序的 score_rounding / probability_rounding 即使高置信也需复核；证据 accepted 依赖当前证据，不能代替测试或部署记录。工具不会执行测试、扫描仓库、重试命令或修改代码。

若看不到工具，先核对生成配置的 Node/入口路径、目标机器和配置加载状态；若启动失败，执行 doctor 检查环境配置。若只有真实调用报错，分别检查 AUTHENTICATION、代理/CA 和已记录的上游错误，不通过重发消耗新的调用预算。验证无需模型时始终保留 dryRun=true。

字段和配置位置依据当前 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)。本项目验证使用官方 MCP Client 经实际 stdio 子进程连接，不等于已操作用户的 Codex 界面或修改了其设置。
