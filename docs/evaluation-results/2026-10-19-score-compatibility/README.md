# Score 兼容策略的离线重放

日期：2026-10-19。重用[首次实测](../2026-10-19-jev-1.13.0/README.md)的全部 36 份 HTTP 响应，实际模型 jev-1.13.0。本轮新增请求为 0，无新增 API 用量；不是新模型测试。原始实测报告及其两个错误保留原状。

## 策略与限制

当前官方 [Score](https://docs.typesafe.ai/primitives/score) 和 [HTTP API](https://docs.typesafe.ai/api) 文档描述概率加权值，未保证小数精度。因此 `rounded-2dp` 是本地兼容假设，不能声称上游确认了误差原因。

保留原有 0.01 容差。超出时，只有分数和概率都在两位小数网格上才检查舍入可行性。令每个舍入前概率落在返回值 ±0.005、裁剪到 [0,1] 的区间，且概率总和为 1；求其最小/最大加权值，与返回分数 ±0.005 区间相交才接收。明显矛盾仍拒绝，不统一把容差提高到 0.02。原始数值不重写，本地 consistency 注解每次重新计算。

rank-candidates 更新为 1.1.0，对新增兼容结果强制 requiresReview，并给出 reviewReason=score_rounding，即使模型 confidence 很高。最低 confidence=0.70、五级 rubric、原始分数归一化和稳定排序均不变。证据/归类规则仍为 1.0.0，评测器仍为 1.0.0。完整边界见 [架构](../../architecture.md)。

## 重放结果

| 指标 | 原实测映射 | 新策略离线重放 |
| --- | --- | --- |
| 全部可计分样本 | 34/36 | 36/36 |
| 排序可计分样本 | 10/12 | 12/12 |
| 排序关键项命中 | 12/12 | 14/14 |
| 排序样本命中 | 10/10 | 12/12 |
| 排序 topK 待复核 | 4/12 | 6/14 |
| 排序全部候选待复核 | 7/31 | 11/37 |
| 排序响应错误 | 2/12 | 0/12 |
| 证据错误接受 / 负例 | 0/8 | 0/8 |
| 归类最终命中 | 11/12 | 11/12 |
| unknown 召回 | 4/4 | 4/4 |

新增可计分的 migration-lock-order、chinese-task 各有两个 Score 使用兼容路径，其中三个 confidence 高于阈值，仍强制 review。详见 [rounding-review.json](rounding-review.json)。两项样本的 top1 都保留复核，不能把关键项命中理解为可以直接执行。其他 34 份响应不增加 consistency 标记；证据与归类的所有指标不变。分母扩展来自重新解释同一批响应，不是模型能力提高的证据。

## 复现与来源

本目录的三个 `*-predictions.json` 保存当时捕获的响应白名单，不含请求原始材料或凭证；绑定当前套件摘要及规则版本。原请求模型为 jev-latest，重放输出 source=recorded。[provenance.json](provenance.json) 保存原始捕获字节的 SHA256、样本 ID、尝试编号及原实现版本；本地 Git 提交标识本次实现。重放不写回原调用记录或数据库，不把失败调用改成历史成功，也不重复累计 token 用量。

仓库根目录执行（无需 key）：

```sh
npm run build
node dist/cli.js evaluate --suite examples/benchmarks/rank.json --predictions docs/evaluation-results/2026-10-19-score-compatibility/rank-predictions.json
node dist/cli.js evaluate --suite examples/benchmarks/verify.json --predictions docs/evaluation-results/2026-10-19-score-compatibility/verify-predictions.json
node dist/cli.js evaluate --suite examples/benchmarks/triage.jsonl --predictions docs/evaluation-results/2026-10-19-score-compatibility/triage-predictions.json
```

聚合报告：[排序](rank-candidates.json)、[证据](verify-claims.json)、[归类](triage-failure.json)。离线测试覆盖全部 36 份捕获响应、四处数值偏差、极端概率/归一化约束、精度不符、伪造注解、强制复核和稳定排序。数据集仍是原来的预标注合成样本，尚无独立新样本、生产质量、阈值校准或效率收益结论。
