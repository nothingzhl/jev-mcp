# 第一轮开发验证

日期：2026-10-19。实际云环境：Linux x86_64、Node.js v24.19.0、npm 11.9.0。修改前工作区干净，已用 npm ci 重装并复现 52 项离线基线。未运行远端 CI；Node 22.16 的运行兼容性仍由待执行的 CI 矩阵覆盖，本轮没有声称已运行该版本。

## 本轮实际执行

- `TYPESAFE_API_KEY= npm run check`：strict 类型检查、90 项离线测试、构建均通过；0 failed、0 cancelled、0 skipped、0 todo。包含两批 72 项响应重放、Score 舍入边界、MCP 配置生成，以及安装器的配置保留、冲突/大小/UTF-8/符号链接、重复执行、六进程争用和安装包装器边界。
- `npm run demo`：成功生成候选排序请求计划，无模型调用、无数据库写入。
- 文档中的编译版 evaluate 命令：JSON 与 JSONL 计划、三个规则的固定预测评分均通过。
- 编译版 compare：合成 A/B 报告保留原始分母与 unknown/review；unknownRecall 差值为 1（0/1 → 1/1）。这仅验证对比器。
- 编译版 CLI/MCP：直接启动产物，检查工具列表与三个规则 dry run；检查 CLI doctor、SQLite 内存 history 与两个 stdio 启动入口。
- `git diff --check` 通过；安装器新增并锁定 smol-toml 1.9.1，用于真实 TOML 解析及候选配置验证；没有修改用户全局配置。
- 第二批 challenge-v1：三个编译版 CLI 无 key 的计划输出与保存快照完全一致；共 36 个样本、89 个问题、36 个逻辑请求。新旧样本 ID/完整输入无重复，标注一一对应，证据负例 13 条，unknown 标签 4 项；请求 state 不包含标签或标注理由。准备阶段未调用模型，详见 [准备说明](challenge-v1.md)。
- 第二批作者复核后重跑全部检查与三个 CLI 计划仍通过。排序套件 1.0.1 明确分页输入前提、修正失败即退出的合成重试循环；本地注入片段验证成功即停、失败后重试、耗尽抛错及 cursor 重复。全部标签保留，完整记录和调用前预算提案见 [复核记录](challenge-v1-review.md)；作者复核阶段没有独立人工复核或新增 API 调用。
- 获新预算授权后，编译版 CLI 完成第二批 36 次真实请求，全部 HTTP 200，应用层 35 成功/1 INVALID_RESPONSE。重开 SQLite 的 36 条元数据及 3 份报告均核对；离线捕获重放的所有指标/错误与原始 live 报告一致。没有修改本轮规则、阈值、标签或重发失败案例，详见 [实测结果](evaluation-results/2026-10-19-challenge-v1/README.md)。
- 后续排序规则 1.2.0 在 Score 概率和超出原容差时要求归一化/期望的联合舍入可行性，强制 probability_rounding/review；原始概率不重写。两批共 72 项历史响应离线可计分，第二批排序关键项 16/16、topK review 4/16；第一批及两批证据/归类指标不变。原始实测报告和数据库仍保留旧错误，本次新增调用为 0，见 [兼容重放](evaluation-results/2026-10-19-probability-compatibility/README.md)。
- Codex 接入：编译版 mcp-config 生成 TOML，经 Python tomllib 实际解析并核对 Node/入口/cwd 路径存在。用解析后的命令启动真实编译版 stdio MCP，官方 Client 列出 4 个工具，并分别完成三个规则 dry run（2/3/2 个问题）；清空 key 的真实工具请求返回 AUTHENTICATION，未创建 SQLite、无模型调用、无协议错误或 stderr 输出。未修改或注册用户的 Codex 配置；配置生成测试还覆盖任意 cwd、路径空格/引号、拒绝多余参数、凭证/代理值不进输出，见 [首次接入指南](codex-quickstart.md)。
- 一键安装：以隔离 config.toml 实际执行两次 `npm --cache /tmp/jev-npm-cache run setup:codex -- --config <隔离路径>`，均完成 npm ci 与构建；第一次 installed，第二次 already-installed，配置字节及 mtime 不变。缓存使用 /tmp 是因为本云环境默认 npm 缓存目录不可写，没有改 HOME 或 npm 全局设置。
- 本地分发：pack:local 产物 `.data/jev-mcp-0.1.0.tgz` 共 73 个白名单文件，SHA256 为 `d1e3d9359791aaea9477a1620ddc267249283e3b8daf06b20f89652bd8047a8f`；不包含 .data、SQLite、源码测试或评测捕获。将最终包复制到独立路径后，用实际 npm exec 安装并注册到另一隔离配置；其他 server 原字节保留。官方 MCP Client 从包内编译入口发现 4 个工具，完成三个 dry run 和缺 key 错误检查，未创建 DB、无协议错误、无模型调用。Codex CLI 使用仅命令行覆盖的 mcp get 验证该表可解析，未写用户的 Codex 设置。
- 环境草稿：尝试保存 NPM_CONFIG_CACHE=/tmp/jev-npm-cache 的建议时，自动审批返回 ASB rejected，未给出具体原因、未确认草稿保存。本轮使用上述已验证的命令级缓存参数完成安装，未重复尝试被拒绝的变更。

## 评测与存储覆盖

- JSON/JSONL 严格样本 schema、唯一 id、标签对应、输入/数量/文件/UTF-8 界限、版本不匹配及零预测计划。
- 稳定并列导致的排序漏项：keyItemHitRate 1/3；证据错误接受：falseAcceptanceRate 1/3、acceptanceErrorRate 1/2；这些固定合成响应有意不全正确。
- unknown/review 的保守映射、分类/覆盖/召回各自分母、零分母 null；失败不计入质量分母，错误样本单独报告。
- 预测文件绑定数据摘要、模型、规则版本与全部样本 ID；选子集仍校验完整预测文件；无效响应拒绝评分。
- 对比保留请求/实际模型、规则与评测器版本、原始指标；拒绝不同套件/子集以及 synthetic 与非 synthetic 混比。
- SQLite v1 → v2 保留全部旧行，新增报告重开读取；实际部分迁移失败回滚，拒绝更新的 schema，字段白名单与原始材料/错误 body 不入库。
- 使用 IPC 屏障让六个独立进程同时初始化新库，以及同时迁移 v1 库后写入，记录完整。

## 入口、取消与错误覆盖

- 官方 MCP Client 经真实 stdio 子进程列四个工具、dry run、缺 key、坏输入，以及经真实 SDK 的合成 HTTP 成功与鉴权失败。协议 stdout 未混入日志。
- 合成传输按已安装 SDK 0.7.0 的 zstd 约定解压较大请求，未改变生产传输配置。
- 在途取消传到 SDK/fetch；排队取消不发请求；取消后仍能成功调用及 dry run。取消原因和 SDK 原始 body 不进入错误输出/SQLite。
- 服务测试覆盖预取消、获取许可后取消、64 个等待项取消释放容量、队列溢出、在途取消及依赖初始化失败后许可可复用，并保留四并发上限。
- 新 CLI 无 key 的计划/外部预测/比较不创建库；仅 --save 保存外部预测摘要。非法模式、缺 live 上限、坏 UTF-8/超大文件和缺 key 均正确报错。
- live CLI 使用测试专用预加载合成 fetch：不足的重试预算在请求前拒绝；401 不重试；全失败输出有效聚合报告、退出码 1，并可保存。这没有访问真实服务。
- 原有 SDK 单层重试、总预算、响应校验、规则边界、隐私与符号链接入口测试继续通过。

## 尚未验证或实现

后续真实复测已完成：三规则技术冒烟、SQLite 重开及 36 个基准案例均执行，34 项可计分、2 项排序响应保持 INVALID_RESPONSE。实际模型为 jev-1.13.0，结果已离线复放核对，见 [评测结果](evaluation-results/2026-10-19-jev-1.13.0/README.md) 和 [首次调试记录](live-validation.md)。这是小规模预标注合成数据的实测证据，尚无生产准确率、阈值校准或效率收益结论，实际费用也未核对。

随后完成[保守 Score 兼容重放](evaluation-results/2026-10-19-score-compatibility/README.md)：rank-candidates 1.1.0 在本地两位小数舍入假设下接收两项旧错误，四处兼容 Score 强制 review。全部 36 份历史响应可计分；排序关键项 14/14、topK review 6/14，证据/归类的所有指标不变。新增请求为 0，未改变原始实测报告或调用记录。官方小数精度契约仍未确认，不能将此离线结果称为新一轮实测。

第二批 challenge-v1 已完成新授权的 36 次实测：排序成功样本关键项 14/14、topK review 3/14，另有一项概率和 0.99 导致响应校验失败；证据错误接受 0/13、verdict 16/17，归类命中 12/12、unknown 召回 4/4。四处 Score 舍入兼容均强制 review，含 confidence=0.96 的 top1。实际模型 jev-1.13.0，响应报告用量 38009/2468 tokens（含失败调用），费用未核对；没有独立人工复核、生产分布或阈值校准证据。

长期运行、持久化 running 状态、进程中断后的在途恢复/exactly-once、多机共享数据库、降级迁移、输入采集适配器和 Web 控制台未实现。本轮多进程测试只验证本机初始化/迁移及元数据写入。真实质量评测需要另行授权与合适的标注样本，按 docs/evaluation.md 显式使用 live 和样本/请求上限。
