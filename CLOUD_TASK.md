# 云端续开发任务

本项目为独立的 Jev 开发辅助 MCP，目标是给 Codex 提供排序、证据核对和失败归类等可审查判断。先阅读 AGENTS.md、README.md 与 docs/architecture.md，再检查实际代码；不要依赖创建骨架的本地聊天记录。

## 当前起点

- TypeScript strict + Node 22.16+（推荐24），使用 npm 与已锁定依赖。
- 三个基础规则：rank-candidates、verify-claims、triage-failure，共用执行服务。
- CLI + 官方 SDK + stdio MCP；generic tool 仅能运行注册规则。
- 请求仅 model/state/questions，只用 Choice、Score、Noul。
- SDK 单层重试、总时限、响应校验、并发上限与安全错误。
- SQLite schema v2，事务保留 v1 调用/旧评测摘要，新增版本化评测聚合报告；不存原始材料或 key，不缓存结果。
- JSON/JSONL 标注集、计划/外部预测/live 评测器、模型/规则版本对比、项目级 Codex skill 与取消/并发边界测试。
- 合成样例、离线测试和 dry-run；首次真实调用覆盖 36 个合成案例，34 项可计分、2 项响应校验错误。生产效果和阈值校准尚无证据。
- 后续保守舍入兼容：rank-candidates 1.1.0，历史 36 项离线重放均可计分，新兼容 Score 强制 review；没有新增调用，也没有确认官方精度契约。原始实测记录保留。
- 第二批合成挑战集及作者自查完成，全部标签保留；排序套件 1.0.1 修正输入前提/合成重试代码，见 docs/challenge-v1.md 和 docs/challenge-v1-review.md。尚无独立人工复核。
- 用户授权的新一轮 36 次尝试已全部执行，无重试/额外冒烟：35 项可计分、1 项排序概率和校验错误；证据错误接受 0/13、verdict 命中 16/17，归类命中 12/12、unknown 召回 4/4。结果见 docs/evaluation-results/2026-10-19-challenge-v1/README.md，不代表生产质量或阈值校准。

先执行：

```sh
npm ci
npm run check
npm run demo
```

## 第一轮任务

完成一个最小可用的评测闭环，并完善 Codex 的使用说明。保持现有结构，不重写成微服务，也不先做 Web 控制台。

1. 实现 JSON/JSONL 标注样本 schema 与离线评测运行器。按规则分别评价排序关键项命中、证据错误接受率、失败归类与 unknown 覆盖率，报告样本数与分母，不用单个平均值掩盖风险。没有模型结果时只验证样本与计划，不伪造准确率。
2. 将套件版本、规则版本、请求与实际模型和评测摘要接入存储；当前评测表不能保存全部这些维度时，添加向后兼容、可验证的 schema migration。原始材料继续留在外部样本文件，默认不入库。
3. 增加 model/recipe 版本对比的 CLI，保留原始指标和 unknown/review；使用固定合成预测验证评测器本身。真实评测命令必须显式选择 live 并限制样本数/请求数。
4. 提供项目自己的 Codex 使用 skill，说明何时调用现有工具、先收集最少材料、如何处理 review/unknown 和如何区分 dry run/真实调用；给出工具不可用时的降级办法。不自动安装全局 skill 或覆盖用户 MCP 配置。
5. 完善 stdio 端到端、取消/排队、SQLite 多连接初始化等真实边界的测试，修复发现的问题，并同步文档。

每完成一项都运行相关测试并修复，最后运行 npm run check 与 npm run demo。云端无 key 时继续完成所有离线工作，并明确报告真实验证缺口。

### 第一轮实现状态

上述五项的离线实现已完成：标注 schema/分项评测、schema v2 增量迁移、evaluate/compare/evaluations CLI、项目级 Codex skill，以及取消/排队和多进程 SQLite 边界测试。运行方式见 [docs/evaluation.md](docs/evaluation.md)，实际验证与未覆盖项见 [docs/validation.md](docs/validation.md)。后续已完成首次小规模真实调用评测，结果仅针对预标注合成样本；尚无生产效果、阈值校准或效率收益结论。

## 后续迭代（本轮不要求）

diff 属性检查、任务/工具选择、重复关联判断；随后考虑输入采集适配器、本地控制台、版本对比展示。结果缓存只有在确认重复调用收益和完整失效键后再加。HTTP 团队服务另行设计鉴权与部署。

## 验收与交付

- 无 key、无数据库的干净环境可 npm ci、check、demo；全部默认检查不发真实 API 请求。
- 同 state 的独立问题单次请求；多个候选稳定排序、不丢候选；证据不足不通过；unknown 不转成执行动作。
- 元数据能重开读取，凭证/输入/日志/代码不进入数据库与错误输出。
- MCP 协议输出干净，可列工具和 dry run；live 错误正确返回 isError。
- 完成评测闭环，文档给出可直接执行的命令和待验证项；报告离线检查与真实模型效果各自证据。

普通云端任务默认不调用真实计费 API。真实验证单独在授权任务中使用合成材料，凭证经服务环境注入，不让用户把 key 贴到对话，不自动传输私有仓库。不要发布 npm 包、推送远端、部署服务或修改本机全局配置。

可直接给云端的任务文字：

> 按 CLOUD_TASK.md 完成“第一轮任务”，遵守 AGENTS.md。先复现当前离线基线，再逐项实现、运行、检查和修复到可交付。没有 TYPESAFE_API_KEY 时完成全部离线工作；不要用 mock 结果声称真实模型质量通过。最后报告改动、测试和真实验证缺口。
