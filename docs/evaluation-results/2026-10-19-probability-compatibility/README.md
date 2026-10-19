# Score 概率和兼容的离线重放

日期：2026-10-19。排序规则更新为 **1.2.0**，将既有 rounded-2dp 兼容检查扩展到 Score 概率和；证据、归类规则和评测器不变。复用两批共 72 份历史响应，新增模型调用 **0**、新增 API 用量 **0**。原始实测报告、捕获响应、调用元数据和旧计划均保留。

## 边界与复核

当前官方 HTTP 契约写明概率和为 1，SDK 0.7.0 未保证小数精度。本策略是本地的保守兼容假设，不是上游契约已确认的误差规则。

Choice 保持原概率和容差 0.001。Score 先保留原校验路径；若概率和偏差超过 0.001，或分数与返回概率的加权值偏差超过 0.01，则必须满足：

1. 分数和所有概率都在两位小数网格上，原始数值均有限且在范围内，key 与 legend 完整匹配。
2. 每个舍入前概率位于返回值 ±0.005、裁剪到 [0,1] 的区间；这些概率能够同时总和为 1。
3. 在上述总和约束下的最小/最大加权值区间，与返回分数 ±0.005 的区间相交。

因此不直接将容差改成 0.01，也不把概率除以其和来悄悄修正。原值、confidence 均保留；新兼容回答强制 review。概率和偏差使用 reviewReason=probability_rounding，并在本地 consistency 中给出 reportedProbabilitySum；原有仅分数偏差仍为 score_rounding。传入的注解不会被信任，每次重算。

redaction-before-formatting 的 candidate_2 原值为 score=0.76、概率 `{0:0.28,1:0.67,2:0.04,3:0,4:0}`，和为 0.99。可行加权区间约 [0.755,0.795]，与 score 的 [0.755,0.765] 相交。例如舍入前概率 `[0.283,0.674,0.043,0,0]` 总和为 1、期望为 0.76，逐项可舍入成原分布。代码只据此标记兼容及复核，不断言这是上游真实分布。

## 重放结果

| 批次与指标 | 原对应报告 | 新策略离线重放 |
| --- | --- | --- |
| 第一批可计分样本（已有 Score 差值兼容） | 36/36 | 36/36 |
| 第一批排序关键项 / topK review | 14/14；6/14 | 14/14；6/14 |
| 第二批可计分样本 | 35/36 | 36/36 |
| 第二批排序可计分样本 | 11/12 | 12/12 |
| 第二批排序关键项 | 14/14 | 16/16 |
| 第二批排序 topK review | 3/14 | 4/16 |
| 第二批排序全部 review | 23/44 | 25/48 |
| 第二批排序响应错误 | 1/12 | 0/12 |

第一批所有指标不变；第二批的证据/归类所有指标不变。唯一新兼容的回答是上面的 candidate_2（confidence=0.73），仍为 review；同样本的 redact（confidence=0.44）也仍待复核，emit 保留原来的高分与置信度。详见 [rounding-review.json](rounding-review.json)。没有扩展 Choice 接受范围，证据的 0/13 错误接受和 verdict 16/17 结果保持原值。

六份新报告 source=recorded，分别为 [第一批排序](readiness-rank-candidates.json)、[证据](readiness-verify-claims.json)、[归类](readiness-triage-failure.json)，以及[第二批排序](challenge-rank-candidates.json)、[证据](challenge-verify-claims.json)、[归类](challenge-triage-failure.json)。分母扩展来自本地规则重新解释相同响应，不是新实测或模型能力提高。原第二批 live 报告的 1 个错误保留，不写回 SQLite 成功记录，也不重复累计其用量。

## 离线复现

仓库根目录执行（无需 key）：

```sh
npm run build
node dist/cli.js evaluate --suite examples/benchmarks/rank.json --predictions docs/evaluation-results/2026-10-19-probability-compatibility/readiness-rank-predictions.json
node dist/cli.js evaluate --suite examples/benchmarks/challenge-v1/rank.json --predictions docs/evaluation-results/2026-10-19-probability-compatibility/challenge-rank-predictions.json
node dist/cli.js compare --left docs/evaluation-results/2026-10-19-challenge-v1/rank-candidates.json --right docs/evaluation-results/2026-10-19-probability-compatibility/challenge-rank-candidates.json
```

两个预测文件从既有捕获复制原响应，只将外部预测头的 recipeVersion 明确设为 1.2.0；没有修改 score、概率、标签或套件输入。套件摘要不包含 recipeVersion，因此数据身份相同。第一批初始 1.0.0 报告中的另两项 Score 差值错误仍作为更早历史保留。

当前 [challenge-plan.json](challenge-plan.json) 是规则 1.2.0 的离线重规划；原 [调用前计划](../../evaluation-plans/challenge-v1.json)和已执行预算仍绑定当时 1.1.0。[provenance.json](provenance.json) 保存来源摘要及版本比较。普通 npm run check 重放两批全部响应，并覆盖概率和偏小/偏大、不可归一化、分数不相容、精度不符、伪造注解及 Choice 继续拒绝的边界。

这些结果不能确定上游舍入机制，也不能推断生产错误率。没有独立新模型响应或人工复核；后续可以用新的独立案例继续检验，但当前无需增加调用来复现这项修复。
