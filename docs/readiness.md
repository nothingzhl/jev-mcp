# 小规模真实验证准备

## 状态和范围

每条规则已准备 12 个样本，共 36 个原创合成案例，不来自私有仓库，不含凭证或用户日志。标签依据现有 rubric 预标注，尚未独立人工复核，也不是生产数据分布。当前仅完成 schema、版本、标签引用和离线计划校验；没有为这些案例生成假预测或质量指标。

前一轮实现已审查并保存为本地提交 `54d55d0`。复查包括输入/响应校验、请求上限、分母、错误与 unknown 区分、取消许可释放、SQLite 字段白名单和迁移。原有 70 项离线测试通过；新增基准资产校验随普通 check 执行。

最初检查缺少 TYPESAFE_API_KEY；后续已注入且平台报告 ready，真实请求也收到 HTTP 200。本次 3 次尝试诊断并修复了 Node 代理配置和 Score 浮点边界误报；三规则冒烟和基准仍未完成，详见 [真实调用记录](live-validation.md)。代理开关及启动说明已保存到环境草稿；保存草稿不等于已在未来任务生效。

## 样本设计与标注依据

| 规则与文件 | 样本/问题数量 | 标注分布 |
| --- | --- | --- |
| [排序](../examples/benchmarks/rank.json) | 12 / 37 | 14 个关键项、topK 共 14 个位置 |
| [证据](../examples/benchmarks/verify.json) | 12 / 12 | supported、contradicted、insufficient 各 4 项 |
| [失败归类](../examples/benchmarks/triage.jsonl) | 12 / 24 | environment、dependency、regression、flaky 各 2 项，unknown 4 项 |

排序关键项覆盖实际定义、缺陷代码、空证据保护、取消链路、迁移锁顺序、存储白名单、协议入口、总时限和中文目标。`cancellation-two-components` 与 `check-command-and-definition` 明确要求两个组件，因此有两个关键项。其他案例有一个直接目标；同名文件、调用方及只让模型打高分的注入指令作为干扰，关键项不固定出现在第一个位置。排序仍保留所有候选及 review。

证据标签的理由如下；一个样本一条声明，以便首次检查单条判定：

| 标签 | 样本 id | 依据 |
| --- | --- | --- |
| supported | completed-test-run、narrow-passing-claim、review-count、chinese-completion | 声明严格对应本次完成记录或显式列出的数据 |
| contradicted | explicit-test-failure、skips-are-not-executed、protocol-content-contradiction、reported-write-error | 已记录失败、跳过、非协议行或存储失败，直接否定声明 |
| insufficient | empty-evidence、plan-is-not-result、revision-mismatch、injected-intent | 无证据、只有意图、版本不符或注入文字，不能证明执行结果 |

证据错误接受率的预设负例分母为 8；真实 accepted/review 数必须从实际输出计数。空证据会按现有规则强制待复核。

| 失败类别 | 样本 id | 依据 |
| --- | --- | --- |
| environment | runtime-missing、directory-permission | 明确缺运行时或目录写入权限 |
| dependency | package-missing、dependency-api-mismatch | 明确缺包或依赖版本导出 API 不匹配 |
| regression | behavior-regression、authentication-guard-regression | 产品改动直接解释对应测试中的错误输出 |
| flaky | documented-unchanged-rerun、explicit-unchanged-fail-pass | 同命令、代码/输入/环境不变的实际失败后通过 |
| unknown | unexplained-failure、retry-only-proposed、injection-without-evidence、recent-change-is-not-cause | 只有退出码、计划重跑、注入指令或时间相邻改动，无法证明原因 |

归类的预设已知标签分母为 8，unknown 召回分母为 4。日志中的指令不是证据，分类也不授予自动重试或修改权限。

## 重复离线校验

在仓库根目录完成构建后：

```sh
node dist/cli.js evaluate --suite examples/benchmarks/rank.json
node dist/cli.js evaluate --suite examples/benchmarks/verify.json
node dist/cli.js evaluate --suite examples/benchmarks/triage.jsonl
```

这些命令不联网、不写库、不生成质量指标。每条规则前 1 个样本的冒烟计划分别含 3、1、2 个问题，各合并为一次请求。

## 密钥就绪后的执行顺序

用户已在本会话授权小规模真实验证。凭证只从服务环境读取，不在聊天、命令参数或文件中粘贴 key。以下是初始执行计划；本次已消耗 3 次调试尝试，后续需扣除该数量。每条规则的冒烟仅取 1 个合成样本，SDK 额外重试设为 0。任一步失败即停止后续调用并诊断，保留非零退出码。

```sh
mkdir -p .data
evaluation_dir="$(mktemp -d .data/readiness-XXXXXX)"
export NODE_USE_ENV_PROXY=1
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" JEV_MAX_RETRIES=0 node dist/cli.js evaluate --suite examples/benchmarks/rank.json --live --max-samples 1 --max-requests 1 --save > "$evaluation_dir/rank-smoke.json" &&
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" JEV_MAX_RETRIES=0 node dist/cli.js evaluate --suite examples/benchmarks/verify.json --live --max-samples 1 --max-requests 1 --save > "$evaluation_dir/verify-smoke.json" &&
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" JEV_MAX_RETRIES=0 node dist/cli.js evaluate --suite examples/benchmarks/triage.jsonl --live --max-samples 1 --max-requests 1 --save > "$evaluation_dir/triage-smoke.json"

JEV_DB_PATH="$evaluation_dir/metadata.sqlite" node dist/cli.js evaluations --limit 3
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" node dist/cli.js history --limit 3
```

仅在三次请求均成功、响应满足 schema、实际模型和元数据能重开读取后推进整套。冒烟只验证接口和存储通路，不提供质量结论。整套沿用同一模型配置，每条规则显式 --max-samples 12 --max-requests 12、JEV_MAX_RETRIES=0；包括前面 3 次冒烟在内，本轮最多 39 次 SDK 请求尝试。这不是 token 或费用限额，不自动切换模型或重复失败请求。

```sh
# 确认冒烟满足上述条件后才分别运行；沿用本次 evaluation_dir：
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" JEV_MAX_RETRIES=0 node dist/cli.js evaluate --suite examples/benchmarks/rank.json --live --max-samples 12 --max-requests 12 --save > "$evaluation_dir/rank-report.json" &&
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" JEV_MAX_RETRIES=0 node dist/cli.js evaluate --suite examples/benchmarks/verify.json --live --max-samples 12 --max-requests 12 --save > "$evaluation_dir/verify-report.json" &&
JEV_DB_PATH="$evaluation_dir/metadata.sqlite" JEV_MAX_RETRIES=0 node dist/cli.js evaluate --suite examples/benchmarks/triage.jsonl --live --max-samples 12 --max-requests 12 --save > "$evaluation_dir/triage-report.json"
```

本次仅尝试了排序的第一个样本，修复后的复测、verify/triage 冒烟及全套仍未执行；不可据此声称三规则已通过。实际质量结果应逐规则列出分子/分母、错误数和 actualModels，优先复核错误接受、关键项漏检、unknown 标签被归成具体类别，以及 review/knownCoverage。先核对标签与证据，再考虑规则修改并建立独立回归集。12 个合成案例不足以估计生产准确率或校准阈值。
