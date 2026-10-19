# 第二批合成挑战集

2026-10-19 准备，后经用户授权完成 **36 次真实调用，35 个样本可计分、1 个响应校验失败**，详见[本批实测](evaluation-results/2026-10-19-challenge-v1/README.md)。每条规则 12 个案例，保存在 [challenge-v1](../examples/benchmarks/challenge-v1/)。输入均为新编写的合成材料，没有私有代码、凭证或用户日志；样本 ID 和完整输入不重复第一批基准。旧套件、真实结果及 Score 兼容重放报告均保留。

案例依据当前规则在调用前预标注，逐例理由及覆盖标签保存在 [annotations.json](../examples/benchmarks/challenge-v1/annotations.json)。尚无独立人工复核，也不是生产分布或统计独立的盲测集；编写时已知规则和第一批结果。实测报告与捕获响应单独保存，标签未根据模型结果调整。

已完成[作者逐例复核](challenge-v1-review.md)，保留全部标签，修正分页输入前提与合成重试循环；排序套件升至 1.0.1，规则仍为 1.1.0。证据/归类套件仍为 1.0.0。[真实预算记录](evaluation-plans/challenge-v1.live-budget.json)为关闭重试的最多 36 次 SDK 尝试，已获授权并用完，没有额外冒烟或重发。

## 套件与覆盖

| 套件 | 规则版本 | 样本 / 问题数 | 标签与未来指标分母 |
| --- | --- | --- | --- |
| [排序](../examples/benchmarks/challenge-v1/rank.json) | 1.1.0 | 12 / 48 | 48 个候选、16 个关键项、topK 总位置 16；4 项要求两个组成部分 |
| [证据](../examples/benchmarks/challenge-v1/verify.json) | 1.0.0 | 12 / 17 | supported 4、contradicted 4、insufficient 9；负例共 13 条 |
| [归类](../examples/benchmarks/challenge-v1/triage.jsonl) | 1.0.0 | 12 / 24 | environment、dependency、regression、flaky 各 2，unknown 4；已知标签共 8 |

每个样本一个批量请求，共 36 个逻辑请求、89 个问题。`plannedRequests` 不包含 SDK 的额外重试；默认额外重试为 1 时执行完整套件需覆盖最多 72 次 SDK 尝试。本次显式关闭重试，实际 36 次，符合新授权。次数上限不等于费用上限；原会话 39 次与本批 36 次预算均已用完。

排序覆盖分页边界、租户 key 与约定、模板与生成副本、同名不同协议、非唯一键、消息注入、进程作用域、Unicode 表示差异、每次尝试新建 timeout、短代码与长概述、活动端点与禁用示例、脱敏调用顺序。关键项位置覆盖四个候选位置。多组件任务明确要求两个部分，避免将同样相关的材料随意标成唯一答案；短片段和缺陷代码仍可属于核心证据。

证据核对有 4 个多声明样本，检查实体、区域、时间、全称量词、复合声明、状态与内容、中文截断日志及不可信指令。`sibling-evidence-isolation` 同次请求含三条声明：一条有健康记录，一条只有分区清单，一条为空证据。后两条均为 insufficient，其中非空清单用于检验跨声明借用证据，避免全部依赖空证据的本地强制 review 掩盖模型错误。

归类区分资源/配置、依赖版本/损坏、直接产品改动证据和实际条件不变重跑。unknown 包括编辑后通过、换 seed 后通过、未核实且冲突的事故解释、没有定位依据的超时注入。失败后通过本身不足以证明 flaky；前述 unknown 不因近期改动或输出中的分类指令而成为具体归因。

## 离线复现

仓库根目录完成依赖安装后运行：

```sh
TYPESAFE_API_KEY= npm run check
TYPESAFE_API_KEY= npm run demo
TYPESAFE_API_KEY= node dist/cli.js evaluate --suite examples/benchmarks/challenge-v1/rank.json --model jev-latest
TYPESAFE_API_KEY= node dist/cli.js evaluate --suite examples/benchmarks/challenge-v1/verify.json --model jev-latest
TYPESAFE_API_KEY= node dist/cli.js evaluate --suite examples/benchmarks/challenge-v1/triage.jsonl --model jev-latest
```

三个 evaluate 输出与已保存的调用前[计划快照](evaluation-plans/challenge-v1.json)中对应的 plan 一致，包含版本、样本摘要、问题数及 networkCallMade=false。快照描述离线准备，只记录 requestedModel=jev-latest；实际模型和质量指标在独立实测报告中。计划由现有 planEvaluation 生成，快照可用以上三个命令复现；标签和标注理由不进入请求 state。

离线测试校验完整 schema、当前规则版本、全部请求的大小与批量结构、计划摘要、标签分布、多声明与多组件覆盖、标注一一对应、无第一批样本/完整输入复用、无 provider 或数据库初始化。它不能证明自然语言标签正确，也不能测出模型置信度、Score 舍入兼容率或 review 实际比例。

## 后续真实评测的判读约定

本轮按以下约定完成真实评测，保持套件和规则版本固定，并记录请求/实际模型、错误码和分母。后续发现标签歧义时，保留原结果并单独记录复核，修改标签时提升套件版本，不能静默改标签来提高分数。新的真实调用仍需对应的新预算。

- 排序同时报告关键项命中 / 16、topK review / 16 和全部 review / 48；分母仅适用于全部成功，否则按成功样本实际计数。Score 舍入兼容结果继续强制 review，不能用命中掩盖该标记。
- 证据同时报告错误接受 / 13 个负例、错误接受 / 实际 accepted、支持接受 / 4 个 supported，以及 verdict/review；零 accepted 的错误接受比例为 null。出现错误接受时逐例复核，不以高总体命中抵消。
- 归类同时报告最终类别、knownCoverage / 8 和 unknownRecall / 4；已知样本保守返回 unknown 会降低覆盖，仍需与错误的具体归因区分。review 越低不一定越好。
- 失败单独计 errorRate，不当作正确 unknown，也不计入质量分母。不得只选择成功响应或重复请求直到得到满意结果。

这些是判读规则，没有预设模型应当达到的准确率或阈值校准结论。未来同一挑战集可比较模型/规则版本；第一批与本批套件不同，现有 compare 会拒绝直接计算跨数据集差值。
