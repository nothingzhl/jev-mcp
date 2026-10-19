# 第二批合成挑战集实测

2026-10-19，经用户授权新一轮最多 36 次调用，实际执行 36 次：每案例一次，SDK 额外重试为 0，无额外冒烟、调试或重发。请求模型 jev-latest，实际均为 **jev-1.13.0**，代码版本 9b68efb。排序套件为 1.0.1 / 规则 1.1.0，证据和归类套件/规则为 1.0.0，评测器 1.0.0。材料均为[预先标注的新合成案例](../../challenge-v1.md)，未上传私有代码或用户日志。

36 个 HTTP 响应均为 200，应用层 35 个成功、1 个 INVALID_RESPONSE。SQLite 重开读到 36 条调用元数据、3 条聚合报告；报告与 CLI 输出逐字段一致。排序 CLI 非零退出后先做离线诊断，再继续未调用的证据和归类套件；没有重新请求失败案例。三个原始报告 source 均为 live。

## 指标与分母

| 规则 | 指标 | 分子 / 分母 | 解释 |
| --- | --- | --- | --- |
| 排序 | 可计分样本 | 11/12 | 另 1 项为完整响应校验失败 |
| 排序 | 关键项命中 | 14/14 | 仅针对成功样本；整套有 16 个标注关键项 |
| 排序 | 样本命中 | 11/11 | 所有成功样本至少命中一个关键项 |
| 排序 | topK review | 3/14 | 包含高置信但仅舍入兼容的 top1 |
| 排序 | 全部候选 review | 23/44 | 失败样本的四个候选不计入 |
| 排序 | 响应错误 | 1/12 | 保留在 errorRate，不计为排序命中或漏项 |
| 证据 | 错误接受 / 负例 | 0/13 | contradicted 4、insufficient 9 |
| 证据 | 错误接受 / accepted | 0/4 | supported 接受 4/4 |
| 证据 | verdict 命中 | 16/17 | 1 条 insufficient 被判为 contradicted，但低置信 review |
| 证据 | review | 9/17 | 没有把正确 verdict 与自动接受混为一项 |
| 归类 | 最终类别命中 | 12/12 | 含 unknown |
| 归类 | 已知类别命中 / 覆盖 | 8/8 | 四种已知类别各两例 |
| 归类 | unknown 召回 | 4/4 | 原因不足、条件有变或解释冲突时保留 unknown |
| 归类 | unknown / review | 4/12 | 不由类别触发自动重试或改动 |

原始报告：[排序](rank-candidates.json)、[证据](verify-claims.json)、[归类](triage-failure.json)。[cases.json](cases.json) 保存逐例标签、结果、置信信息与安全错误；不含请求原始材料。

## 一项校验失败

redaction-before-formatting 的 candidate_2 返回概率 `{0:0.28, 1:0.67, 2:0.04, 3:0, 4:0}`，和为 0.99，超过冻结的概率和容差 0.001，因此整条响应为 INVALID_RESPONSE。其余三个候选的数值不使该响应局部成功；没有将两个关键项偷偷计入命中。

该问题与 score/加权值相差 0.02 的兼容路径不同：概率分布校验在前，尚未进入 Score 舍入检查。分别舍入可能解释 0.99，但当前契约与规则没有允许此差额。本轮保留失败，不修改阈值、输入或标签来消除错误。后续可以用该捕获离线调查，无需重发案例。

## 舍入兼容与 verdict 差异

成功响应中有 4 个 Score 通过 rounded-2dp 兼容路径，均保留 score/probabilities/confidence 与强制 review，详见 [rounding.json](rounding.json)。其中三处同时低置信；cursor-inclusive-boundary 的 predicate 为 top1、confidence=0.96，仍为 score_rounding/review。这提供了新响应上的兼容与复核证据，官方精度保证仍未确认。

copy-started-not-completed 的预标注是 insufficient：只记录复制开始，没有完成或远端校验结果。模型选择 contradicted（概率 0.58，insufficient 0.42），confidence=0.37，最终 status=review、canAutoAccept=false。保留此 verdict 错误，没有把“没有完成记录”改标成“明确失败”。原始差异见 [discrepancies.json](discrepancies.json)。

## 来源、重放与用量

[captures.json](captures.json) 保存 36 份实际响应的白名单字段及样本 ID/尝试编号，包括被拒绝的概率分布，不含请求体或凭证。该文件不是完整有效的 `--predictions` 文件：排序中的无效分布必须仍能重放为错误，不能用普通外部预测的完整校验跳过它。

已通过现有响应校验和评测执行器，以捕获响应作为本地 provider，离线重放全部 36 项；没有初始化 SDK、没有网络请求、没有新数据库写入。分项指标、错误计数和实际模型集合与原报告完全一致。普通 `npm run check` 也包含该回归。

全部 36 份 HTTP 响应报告 input_tokens=38009、output_tokens=2468，无缺失字段，含校验失败的调用。SQLite 对失败行不保存用量，不能只加总成功行当作完整用量；[provenance.json](provenance.json) 保留完整响应加总及来源摘要。实际费用未核对。

本批来自同一作者的预标注合成数据，尚无独立人工复核、生产分布或阈值校准证据。0/13 错误接受不意味着生产错误率为零。第一批与本批数据不同，不计算跨套件准确率差值作为模型改进；本轮 36 次预算已耗尽。
