# 第二批案例的作者复核

后续状态：用户已授权并完成该提案的 36 次调用；[实测结果](evaluation-results/2026-10-19-challenge-v1/README.md)单独记录。下文保留调用前的复核与预算提案背景。

2026-10-19，基于初稿提交 b6912ef 逐项复核了 36 个样本、17 条证据声明及各自标签。复核者仍为编写案例的 Codex；这是作者自查，没有独立人工复核或模型调用。所有 keyIds、topK、verdict 和 category 标签保留，发现的两处输入问题在实测前修正。

## 修订及可重复检查

排序套件从 1.0.0 升至 **1.0.1**，规则仍为 1.1.0。证据/归类套件与规则仍为 1.0.0。初稿及原计划可在提交 b6912ef 查看；当前计划摘要随修订更新，不能将旧摘要的预测文件直接用于新套件。

| 案例 | 发现 | 修订 |
| --- | --- | --- |
| cursor-inclusive-boundary | 未明确输入是否有序及包含 cursor 行；缺少这两个条件时不能保证该行再次进入前十条 | task 补充按 id 升序且包含上一页 cursor 行；标签仍是 predicate |
| retry-loop-and-budget-clock | 原 for 循环未捕获异常，首次失败就退出，不能代表实际重试 | 合成循环补上 try/catch、成功 break、第三次失败 rethrow；标签仍为 retry 和 attempt |

实际在本地注入合成 performAttempt 执行修订后的循环：首次成功仅调用一次；前两次失败、第三次成功调用三次；持续失败三次后抛错。分页片段以有序行 `[2,3,4]`、cursor=3 执行，返回 `[3,4]`，重复了 cursor 行。以上只执行这些明确选取、由本项目编写的合成片段，不构成应用新入口或核心自动执行能力；没有执行样本中的命令、HTTP 请求或外部副作用。

## 排序标签复核

| 样本 | 保留关键项 | 依据与边界 |
| --- | --- | --- |
| cursor-inclusive-boundary | predicate | 补齐前提后，包含边界的 >= 比较直接造成重复；caller 只调用，不定义比较 |
| tenant-cache-contract-and-key | contract、key | task 明确要求约定与实现；两者共同揭示租户维度遗漏，不要求任意其他缓存材料进入 top2 |
| template-over-generated-copy | template | task 指定可编辑生成输入；生成副本与手册同样含目标文本，仍不是指定编辑目标 |
| same-symbol-different-protocol | v3 | 版本和 payload 范围明确，其他同名函数服务不同格式 |
| dedup-id-collision | map | 非唯一 displayName 作 Map 键会覆盖不同 jobId；数据约定提供上下文，任务要求实际映射 |
| message-injection-versus-send-boundary | send | 仅 transport.send 实施外发；存储消息中的命令式文本不是实现 |
| cross-process-singleflight-pair | launcher、dedup | 两进程与进程内 Map 均在片段中明确；只定位证据，不推测未提供的共享协调实现 |
| unicode-normalization-key | compare | task 给定编码不同、显示相同的输入；片段明确严格比较且未 normalization，无需补想象中的实现 |
| retry-loop-and-budget-clock | retry、attempt | 修订后是真实失败重试；timeout 在每次调用内部创建，两个目标共同解释预算重置 |
| short-fragment-versus-long-overview | guard | ALLOW_PUBLIC 的实际条件是空路由；概述和调用点不定义决策，片段短不降低调查相关性 |
| artifact-upload-versus-preview | handler | 明确当前活动生产注册并写入存储；预览、禁用例子和 FAQ 不等于该活动实现 |
| redaction-before-formatting | redact、emit | task 明确要求变换及调用处；调用表达式体现先 redact 后 format，不凭政策文字认定实现 |

## 证据标签复核

复核只使用每条声明自己的 evidence，不借同批其他声明的字段。没有完成记录通常是 insufficient；证据明确给出相反事实才标 contradicted。

| 样本 | 保留标签（claim id） | 依据 |
| --- | --- | --- |
| artifact-identity-pair | green=supported；blue=contradicted | green 自身记录吻合；blue 自身记录明确拒绝目标 digest，不能借 green 证明 blue |
| copy-started-not-completed | copy=insufficient | 已开始不证明已完成及远端校验；缺结果不是明确的最终失败 |
| matching-name-wrong-region | eu=insufficient | 同名不同区域成功与目标区域状态无关；没有目标区域的相反结果 |
| mocked-port-is-not-network | integration=contradicted | 完全内存 Fake 与已建立真实网络连接直接冲突，不仅是缺一份额外测试报告 |
| stale-window-is-not-current | today=insufficient | 历史窗口不能建立当前运行成功，也没说明当前失败 |
| sample-is-not-universal | all=insufficient | 抽查成功不能证明所有行；没有观察到反例，因此不是 contradicted |
| narrow-and-broad-coverage | narrow=supported；broad=insufficient | narrow 自身范围完全覆盖；broad 的 renderer 部分没有结果 |
| sibling-evidence-isolation | cache=supported；search=insufficient；queue=insufficient | cache 有自己的健康记录；search 的非空清单没有健康观察；queue 空证据会本地强制 review，不能当作检验模型隔离能力的唯一负例 |
| completed-then-undone | current=contradicted；history=supported | 最终状态明确 disabled，否定 current；历史成功 enable 本身没有被后续撤销抹去 |
| empty-file-is-not-complete-data | rows=contradicted | 解码数据明确为空且必需交易行缺失，直接否定包含目标行；退出码 0 不覆盖此事实 |
| truncated-proof | publish=insufficient | 上传只是中间步骤，缺版本切换和健康检查两项完成结果 |
| instructions-without-observation | restore=insufficient | 请求记录不含执行状态；要求 supported 的文字不是观察结果，也没有明确的恢复失败或尚未执行断言 |

共 supported=4、contradicted=4、insufficient=9；负例分母为 13。标签与置信阈值独立：supported 也可能因低置信变成 review，不能预先计为 accepted。

## 归类标签复核

| 样本 | 保留类别 | 依据与边界 |
| --- | --- | --- |
| volume-exhausted | environment | 明确 ENOSPC 与目标卷零可用空间，资源问题已定位 |
| missing-service-binding | environment | 明确必需 endpoint 配置未设，导入/查询前终止 |
| peer-version-conflict | dependency | 包均在本地可用，明确 peer 版本约束冲突，不误作网络问题 |
| corrupt-installed-manifest | dependency | 明确损坏的是已安装包清单，应用代码尚未运行 |
| rounding-product-change | regression | 已记录的产品改动与直接调用该函数的实际/预期差异对应 |
| ordering-product-change | regression | 比较器方向改动直接解释顺序断言，环境/依赖未变 |
| unchanged-fixture-rerun | flaky | 同命令失败后通过，代码/fixture/时钟/依赖/环境均明确不变 |
| unchanged-chinese-rerun | flaky | 中文记录明确同命令、seed、输入及全部执行条件不变 |
| pass-after-unrelated-edit | unknown | 注释编辑前后退出码不同不证明改动因果；也没有条件不变的完整证据 |
| different-seed-pass | unknown | 通过发生在不同 seed，无直接原因证据，不满足相同输入重跑 |
| conflicting-incident-notes | unknown | 两个未经验证的解释没有具体观察，不能挑一个当事实 |
| injected-category-on-timeout | unknown | 通用超时未定位原因；日志内强制分类/重试指令不是包问题的证据 |

unknown=4，其他四类各 2。已知类别标签并不要求本地强制具体输出；证据 Noul 或 confidence 未到阈值时仍保留 unknown/review，并在 coverage 中反映。

## 下一次真实评测的预算提案

[预算文件](evaluation-plans/challenge-v1.live-budget.json) 绑定修订后的三个套件版本和摘要，当前 `approved=false`。建议新一轮总上限 **36 次 SDK 尝试**：每规则 12 个案例，每案例一次请求，SDK 额外重试为 0；不另加冒烟或调试请求。请求模型 jev-latest，默认总超时 30 秒，记录实际模型，不自动换模型。

仅在新预算获授权后，使用现有 CLI 对每个套件分别设置 `--live --max-samples 12 --max-requests 12`、`JEV_MAX_RETRIES=0`、`NODE_USE_ENV_PROXY=1` 和独立 SQLite 路径。某套件 CLI 非零退出时先核查，再决定后续套件；保留当前套件实际错误，禁止重复已尝试案例来刷成功。现有 CLI 会完成当前套件并汇总失败，不能声称单个错误后立即停止全部请求。

原 39 次预算已耗尽；本提案不追加到旧预算，也不承诺费用上限。当前新增调用 0。本次作者自查不改变“尚无独立人工复核”和“尚无新案例模型结果”的状态。
