# jev-mcp

为编码代理提供 TypeSafe Jev 判断能力的本地工具骨架。TypeScript 模块化单体，共用版本化规则和执行服务，提供 CLI 与 stdio MCP。Jev 提供判断和概率，本地代码负责排序、阈值、错误处理和存储。

当前提供三个规则、官方 SDK 适配、超时与 SDK 重试、响应校验、SQLite 元数据存储、JSON/JSONL 评测闭环及模型/规则版本对比。评测器通过固定合成预测验证，并已完成首次小规模真实调用评测；生产效果和阈值校准尚未验证。控制台和输入采集适配器仍属后续开发，详见 [CLOUD_TASK.md](CLOUD_TASK.md)。

本地交付证据与未覆盖项见 [docs/validation.md](docs/validation.md)。仓库提供22.16/24的离线 CI 配置，尚未在远端运行。

## 快速运行（无需 key）

使用 Node.js 24；最低版本 22.16。使用 Node 自带的 `node:sqlite`，部分 Node 版本会在 stderr 提示实验性警告。

```sh
npm ci
npm run check
npm run demo
node dist/cli.js recipes
node dist/cli.js doctor
node dist/cli.js mcp-config
```

`demo` 是 dry run：打印准备发送的请求，不联网、不写数据库，也不返回模拟的模型判断。所有测试使用合成数据和注入的本地传输，测试无需 key，不调用真实 API。安装依赖需要访问 npm registry。

## CLI

```sh
# 检查三个规则的请求
node dist/cli.js run rank-candidates --input examples/rank-candidates.json --dry-run
node dist/cli.js run verify-claims --input examples/verify-claims.json --dry-run
node dist/cli.js run triage-failure --input examples/triage-failure.json --dry-run

# JSON 也可经 stdin 输入
node dist/cli.js run rank-candidates --input - --dry-run < examples/rank-candidates.json

# 查看本机调用元数据
node dist/cli.js history --limit 20

# 无预测时只校验评测样本和计划，不伪造准确率
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl

# 固定合成预测，只验证评测器；可选 --save 保存聚合元数据
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl --predictions examples/evaluation/triage-predictions-a.json
node dist/cli.js evaluations --limit 20
```

完整样本格式、指标分母、版本对比及显式 live 上限见 [评测说明](docs/evaluation.md)。默认评测与合成预测评分无需 key 或数据库；评测指标保留错误接受、unknown/review 和调用失败，零分母为 null。真实评测必须显式选择 `--live --max-samples N --max-requests N`，请求预算包含 SDK 最坏情况下的重试，不代表费用限额。

另提供每条规则 12 项、共 36 个原创合成标注案例。[首次实测](docs/evaluation-results/2026-10-19-jev-1.13.0/README.md) 已完成三规则技术冒烟及全部案例尝试：34 项可计分、2 项排序响应校验失败。报告保留错误率与各自分母，不据此推断生产准确率。

随后加入保守的 Score 舍入兼容检查，排序规则更新为 1.1.0：[离线重放](docs/evaluation-results/2026-10-19-score-compatibility/README.md) 可计分 36/36，新增兼容结果强制待复核，没有新增调用。此策略是假设两位小数舍入的本地兼容边界，官方尚未保证该精度；不能据此把待复核结果自动通过。

[第二批合成挑战集](docs/challenge-v1.md)包含 36 个新案例、17 条证据声明及 48 个排序候选。[实测](docs/evaluation-results/2026-10-19-challenge-v1/README.md)完成 36 次调用、35 项可计分；证据错误接受 0/13，归类命中 12/12，排序保留 1 项概率和校验错误。尚无独立人工复核或生产质量结论。

当前排序规则为 1.2.0，增加 Score 概率和的有界舍入兼容，强制 probability_rounding/review，Choice 保持原校验。[两批历史离线重放](docs/evaluation-results/2026-10-19-probability-compatibility/README.md)共 72/72 可计分；第二批排序关键项 16/16、topK review 4/16。原始错误记录保留，本次兼容修复没有新增调用，官方小数精度契约仍未确认。

真实调用需要在服务进程环境中安全配置 `TYPESAFE_API_KEY`，然后去掉 `--dry-run`。不要把 key 放进命令参数、对话、配置示例或版本库。`.env.example` 仅供参考；程序不会自动加载 `.env`。`doctor` 只报告 key 是否存在，不验证有效性。

真实调用会把显式输入的材料发送到 TypeSafe 并产生 API 用量。服务不扫描仓库、不执行测试命令。CLI 的 dry-run 输出包含显式提供的原始材料，保存或分享前自行检查。

| 规则 | MCP 工具 | 行为 |
| --- | --- | --- |
| `rank-candidates` | `jev_rank_candidates` | 同次请求评价候选，代码稳定排序，保留全部候选和原始判断 |
| `verify-claims` | `jev_verify_claims` | 检查指定证据是否支持命题，低置信或证据不足返回待复核 |
| `triage-failure` | `jev_triage_failure` | 结合命令、日志与改动摘要归类，保留 unknown，不执行重试 |

输入字段和长度限制见 `examples/` 与对应 `src/recipes/` 文件。每个规则文件同时保存输入 schema、问题、阈值和结果映射；阈值是初始启发值，尚未通过真实标注样本校准。

## stdio MCP

构建后使用 `node dist/mcp.js` 启动，或使用 `node dist/cli.js serve`。stdout 仅承载 MCP 协议；开发时可用 `npm run mcp`，客户端正式配置应直接启动 Node，避免 npm 输出干扰协议。

工具列表包含三个专用工具，以及 `jev_run_recipe`。后者只能运行注册规则，支持 `dryRun: true`，不接受任意模型问题或任意文件路径。

运行 `node dist/cli.js mcp-config` 生成当前机器和检出目录的绝对路径配置，按[首次接入指南](docs/codex-quickstart.md)合并到 Codex 设置。命令只输出 TOML，不写设置或凭证值；代理与 CA 变量通过 env_vars 按名字转发。便携样例仍在 [examples/codex-config.toml](examples/codex-config.toml)，配置字段依据 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)。

项目级 [Codex 使用 skill](.agents/skills/jev/SKILL.md) 说明何时调用工具、最少材料、授权、review/unknown 处理与工具不可用时的降级方式；不安装全局 skill 或覆盖用户配置。

例如，先通过 `jev_run_recipe` 调用：

```json
{
  "recipeId": "rank-candidates",
  "input": {
    "task": "Find the code that validates a session token",
    "candidates": [
      { "id": "a", "title": "session.ts", "content": "export function validateSession(token) { return token.length > 0; }" }
    ]
  },
  "dryRun": true
}
```

工具可发现不代表已调用模型。真实结果包含规则版本、请求模型、实际模型、耗时、token 用量、request ID 和原始判断；不提供尚未实现的缓存命中或估算费用。

## 配置与存储

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 无 | 仅服务端读取的 API 凭证 |
| `JEV_MODEL` | `jev-latest` | 请求模型；记录同时保存实际返回的模型 |
| `JEV_DB_PATH` | `.data/jev.sqlite` | SQLite 路径，相对服务进程 cwd 解析；可用 `:memory:` |
| `JEV_TIMEOUT_MS` | `30000` | 单次评估的总时限，包含 SDK 重试等待，范围 100..120000 |
| `JEV_MAX_RETRIES` | `1` | SDK 额外尝试次数，范围 0..3；应用层不再重试 |

执行服务最多并行 4 个评估，等待队列最多 64 项。排队取消立即移除等待项，不创建依赖或发出推理请求；在途取消传递给 SDK。总时限从评估开始计算，不包含本地排队时间。上游失败与低置信判断使用不同结果路径，存储失败也会显式返回。

SQLite schema v2 保存调用元数据，以及含套件/规则/请求与实际模型版本、分项指标和来源的评测聚合报告。通过事务迁移保留 v1 数据，不为旧摘要伪造缺失维度。没有 state、代码、日志、key 或原始判断列；不缓存结果。并发初始化/迁移在写锁内复查版本，不支持的更新 schema 会被拒绝打开。

## 代码结构

```text
src/
  core/        判断契约、统一错误与执行服务
  recipes/     版本化输入、问题、阈值和结果映射
  providers/   TypeSafe 官方 SDK、响应校验
  storage/     SQLite 元数据适配器
  evaluation/  标注样本、分项指标、运行器和报告对比
  application.ts 依赖组装（无 key 时仍可列工具和 dry run）
  cli.ts       CLI 入口
  mcp.ts       stdio MCP 入口
test/          离线契约、规则、持久化和入口验证
examples/      合成样例与配置示例
.agents/skills/jev/  项目级 Codex 使用说明
docs/          架构和交付记录
```

官方契约参考：[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[HTTP API](https://docs.typesafe.ai/api)、[批量判断](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。请求顶层保持 `model`、`state`、`questions`，规则仅使用 Choice、Score、Noul。
