# 评测闭环

评测器只读取显式给定的 JSON/JSONL 文件，不扫描仓库。每个套件对应一条规则及其版本。默认无 key、无数据库、无网络；缺少预测时只验证样本和请求计划，不产生质量指标。

首次真实验证使用的 36 个合成标注案例、标注理由和请求上限见 [小规模真实验证准备](readiness.md)，实际结果见 [首次实测](evaluation-results/2026-10-19-jev-1.13.0/README.md)。下文的固定预测文件用于验证评测器本身，与该实测记录分开。

## 可直接运行的离线流程

在仓库根目录完成 `npm ci`、`npm run build` 后：

```sh
# 校验 JSONL 标注样本与计划，不生成准确率
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl

# 固定合成预测：验证评测器，不代表真实模型效果
node dist/cli.js evaluate --suite examples/evaluation/rank.json --predictions examples/evaluation/rank-predictions.json
node dist/cli.js evaluate --suite examples/evaluation/verify.json --predictions examples/evaluation/verify-predictions.json
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl --predictions examples/evaluation/triage-predictions-a.json > /tmp/jev-report-a.json
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl --predictions examples/evaluation/triage-predictions-b.json > /tmp/jev-report-b.json
node dist/cli.js compare --left /tmp/jev-report-a.json --right /tmp/jev-report-b.json

# 仅显式 --save 时保存离线评测摘要；原始材料不入库
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl --predictions examples/evaluation/triage-predictions-a.json --save
node dist/cli.js evaluations --limit 20
```

合成 triage A 的分类命中为 1/3、unknown 率为 1/3、unknown 召回为 0/1；B 分别为 2/3、2/3、1/1。对比同时保留这些数值和 review/coverage，不生成一个“最佳模型”结论。排序样例刻意包含稳定并列导致的漏项；证据样例刻意包含一次错误接受，证明风险指标能够失败。

## 标注样本格式

JSON 是以下头字段加 `samples` 数组。JSONL 的第一条非空行是同样的头字段（不能带 samples），其后每条非空行是一个样本。示例：[rank](../examples/evaluation/rank.json)、[verify](../examples/evaluation/verify.json)、[triage JSONL](../examples/evaluation/triage.jsonl)。

```json
{
  "schemaVersion": 1,
  "suite": "my-labeled-suite",
  "suiteVersion": "1.0.0",
  "recipeId": "triage-failure",
  "recipeVersion": "1.0.0",
  "samples": [
    {
      "id": "missing-runtime",
      "input": { "command": "node example.js", "log": "node: command not found" },
      "expected": { "category": "environment" }
    }
  ]
}
```

所有对象拒绝未知字段；样本 id 唯一。文件上限 10 MiB，套件 1..1000 个样本，input 遵循各规则的现有严格 schema。id 最多 128 字符、版本最多 100 字符、模型名最多 200 字符。版本字段是不透明标识，不要求 SemVer。标注由外部人员或数据源负责，schema 无法证明自然语言标签正确。

| 规则 | expected | 校验 |
| --- | --- | --- |
| rank-candidates | `{ "keyIds": ["a"], "topK": 1 }` | keyIds 唯一且必须是输入候选；topK 在候选数量以内 |
| verify-claims | `{ "claims": [{ "id": "a", "verdict": "supported" }] }` | 每条输入声明恰好一个标签；verdict 为 supported / contradicted / insufficient |
| triage-failure | `{ "category": "unknown" }` | regression / environment / dependency / flaky / unknown |

运行时 recipeVersion 必须与已安装规则一致；不会悄悄替换套件版本。以后比较规则版本时，先审查并更新套件的 recipeVersion，再使用对应版本的代码重新运行，保留旧报告。

## 外部预测文件

预测文件包含 `schemaVersion: 1`、`source: "synthetic" | "recorded"`、`suiteDigest`、`recipeVersion`、`requestedModel`，以及 `predictions: [{ sampleId, response }]`。suiteDigest 从计划输出读取；必须覆盖整个套件，不能重复、错配或漏掉样本。`--max-samples N` 可评测前 N 个样本，仍会校验完整预测文件。

response 使用规范化的 `EvaluationResponse`：`model`、`answers`、`usage: { input_tokens, output_tokens }`、`requestId`。不适用的 usage 和 requestId 使用 null。每个 answer 必须满足原有响应校验：问题 ID/类型一致、完整概率分布、Score legend 与规则一致、score 与分布一致等。参考已提交的四份 `*-predictions-*.json` / `*-predictions.json` 文件。不会从简写标签伪造概率或置信度。

source 是文件声明的来源，不构成真实性证明；synthetic 必须一直显示为合成验证。recorded 用于调用者在外部保留的规范化真实响应。CLI 默认采用文件声明的 requestedModel；显式 --model 如与之冲突则拒绝。原始回答留在这些外部文件，不写入 SQLite。

## 指标及分母

每个指标包含 `numerator`、`denominator`、`rate`。零分母时 rate 为 null，不显示 0% 或 100%。使用规则实际输出的保守映射结果计分，包括空证据强制 review 和低置信归类转 unknown；不重新定义规则阈值。

| 规则 | 指标 | 分子 / 分母 |
| --- | --- | --- |
| 排序 | keyItemHitRate | topK 内命中的标注关键项 / 全部标注关键项 |
| 排序 | sampleHitRate | 至少命中一个关键项的样本 / 成功评测样本 |
| 排序 | reviewRate / topKReviewRate | 待复核候选 / 全部候选，及 topK 内的相同比率 |
| 证据 | falseAcceptanceRate | 错误接受的非 supported 标签 / 所有非 supported 标签 |
| 证据 | acceptanceErrorRate | 错误接受 / 所有 accepted 输出 |
| 证据 | supportedAcceptanceRate | 接受的 supported 标签 / 所有 supported 标签 |
| 证据 | verdictAccuracy | 最终 verdict 与标签相同的声明 / 全部声明 |
| 证据 | reviewRate | review 声明 / 全部声明 |
| 归类 | categoryAccuracy | 最终类别命中（含 unknown） / 成功评测样本 |
| 归类 | knownCategoryAccuracy | 非 unknown 标签中类别命中 / 全部非 unknown 标签 |
| 归类 | unknownRate | 输出 unknown / 成功评测样本 |
| 归类 | unknownRecall | unknown 标签中输出 unknown / 全部 unknown 标签 |
| 归类 | knownCoverage | 非 unknown 标签中输出具体类别 / 全部非 unknown 标签 |
| 归类 | reviewRate | requiresReview / 成功评测样本 |
| 所有 | errorRate | 调用失败样本 / 本轮选择样本 |

`totalSamples`、`evaluatedSamples`、`failedSamples` 和安全错误码计数单独保留。失败不算正确的 unknown，也不进入质量指标分母；需结合 errorRate 判断覆盖缺口。实际模型可因服务路由变化而有多个，以 actualModels 数组完整记录。未运行的样本不进入本轮报告。

## 真实评测

仅在已有针对当前任务、合成/公开材料和 API 用量的授权，且服务环境安全注入 TYPESAFE_API_KEY 后运行。普通测试不调用真实 API。示例命令本身不代表本仓库已验证真实调用：

```sh
node dist/cli.js evaluate --suite examples/evaluation/triage.jsonl --live --max-samples 2 --max-requests 4 --model jev-latest --save
```

live 与 predictions 互斥。两个上限都必须显式提供，max-samples 为 1..1000、max-requests 为 1..4000。执行顺序是文件中的前 N 个样本，一次样本一个批量请求，无应用层重试。max-requests 预算必须至少覆盖 `实际选择样本数 × (1 + JEV_MAX_RETRIES)`；不足时在调用前拒绝。它是 SDK 请求尝试的保守上限，不是假称已发生的真实请求次数，也不是 token/费用限额。

上游错误按样本计数，不冒充质量结果。报告有失败时 stdout 仍为有效 JSON，CLI 退出码为 1；调用者必须保留该退出码。合法 --save 会保存这份含失败计数的报告。全失败报告的质量指标分母为零，actualModels 为空。SIGINT 等进程中断不保证得到完整套件摘要，已经发生的调用可能计费；不提供 exactly-once 保证。

真实调用通过现有服务保存单次调用元数据，是否 --save 仅控制套件摘要。SQLite 初始化失败发生在模型请求前；推理后写入失败不会自动再推理。无 key 时明确报 AUTHENTICATION，不创建本地库或发出请求。

## 版本对比和存储

`compare` 读取两个单报告 JSON 文件（每个最多 1 MiB；最多一个输入用 `-` 表示 stdin）。要求套件身份/版本、全部样本及标签摘要、选择的样本顺序/数量、规则 ID 与 evaluatorVersion 一致。摘要使用规范化 JSON 的 SHA-256，包含显式输入和标签，不含 recipeVersion，以允许跨规则版本对比。比较不同子集或修改标签后必须重新生成匹配报告；不会静默取交集。

model/recipeVersion 可以不同；synthetic 和非 synthetic 不可混比。对比保留左右完整聚合报告，逐指标给出 `右 rate - 左 rate`，零分母时 delta 为 null，不汇总评分或抹去 unknown/review。不同调用失败数量仍可比较，但必须同时查看左右原始分母、模型集合和 errors。

SQLite schema v2 以事务增加 evaluation_reports 表，保存套件/规则/评测器版本、请求/实际模型、样本摘要与数量、来源、指标分子分母和安全错误计数。v1 runs/evaluations 及其内容原样保留；旧评测表缺少维度，不伪造补齐为新报告。新库直接初始化 v2；迁移在写锁内读取版本，失败回滚。更新后的代码可读取 v1 数据，旧版程序不支持打开 v2，未实现降级迁移。

库中不含原始输入、代码、日志、标注内容、完整判断或凭证。摘要不是匿名化保证：套件/模型等元数据名称也应避免携带敏感原文。六进程并发初始化/迁移已由离线测试验证；这不等于长期共享服务数据库的运行承诺。
