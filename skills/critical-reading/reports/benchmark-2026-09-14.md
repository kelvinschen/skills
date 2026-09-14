# Luna 独立案例基准评测

日期：2026-09-14。执行器：`gpt-5.6-luna`。编排：Acpus 0.15.3。

三个案例均完成。两道机制题出现了实质性的约束分析与复算，零增量案例没有强行制造知识；同时发现来源归属与结论强度仍有问题。本批为小规模定性评测，不给统一分数或生产就绪结论。

## 实验设置与证据范围

- 三个独立临时目录、三个新会话，每次工作流只含一个 Agent、一个真实请求；没有中途提示、重试或结果修补。
- 全部使用同一份技能运行文件快照：`SKILL.md` 和两份 `references/`。维护报告、触发配置、私人会话、审查标准均未放入执行器的允许读取范围。
- 冻结合成文章、配套事实与读者背景，禁止联网、跨案例读取和委派。隔离依靠独立会话、目录与提示边界，不宣称是操作系统安全沙箱。
- 审查标准在任务提交后、读取任何结果之前写入执行器目录之外，后续未按输出调整。不是预注册或外部盲评。
- 一次读取 Summary，再各使用一次 `--await-decision` 等到完成。终止后检查 Timeline 与 `turn-001.json`，并核对冻结定义及实际调用中的模型均为 `gpt-5.6-luna`。
- 三份 settled turn 均未提供 `sessionProjectionPath`；使用 Timeline、工具摘要与完整回复作为证据，没有完整 ACP 会话投影。不能从未提供的内容推断内部行为。

[实验清单与哈希](/tmp/critical-reading-luna-20260914-l4b9hbar/manifest.json)记录输入、技能快照、运行 ID、模型绑定与产物校验；[人工审查标准](/tmp/critical-reading-luna-20260914-l4b9hbar/rubric.md)记录判据。每例只检验冻结材料下的行为，没有无技能或旧版对照，不能据此归因于本次技能修改，也未检验开放互联网取证能力。

难度边界：工单材料的分层数据精确且完整，节电原文已提示回路占比，零增量案例明确列出读者已有知识。因此，本批能观察是否正确使用现成材料和约束，不能证明面对含混长文、缺失数据或陌生领域时也能独立发现决定性机制。

## 结果

| 案例 | 主要观察 | 判定 |
|---|---|---|
| 工单效率归因 | 复算 11.6→9.2 分钟、约 20.69% 降幅；识别类别均值不变、权重变化；拒绝直接推导减员比例。线索扩展归属与因果措辞有缺陷。 | 部分通过 |
| 照明控制器节电 | 从可控回路与不变部分推出上限约 3.99%；算出条件下净节电 158.56 kWh、约 1.59%；保留正确主结论并纠正错误理由，寿命收益标为待验证。 | 核心行为通过 |
| 科普内容无增量 | 核实文章正确，并结合读者已有知识明确不新增可靠结论或研究线索；仍写出空栏目和较多复述。 | 筛选行为通过，表达可收紧 |

### 第一性原理确有行为证据

[工单结果第 28 行](/tmp/critical-reading-luna-20260914-l4b9hbar/case-01/output/result.md:28)将前后类别权重与类别均值交叉组合，识别总体变化的数学来源；并区分操作时间与端到端服务效率。它没有只停在“相关不等于因果”的抽象提醒。

[节电结果第 11 行](/tmp/critical-reading-luna-20260914-l4b9hbar/case-02/output/result.md:11)先确定其他 9600 kWh 不变，再以可控 400 kWh 构造上界，并计入控制器自耗。这把“不能单独节省 20%”与“仍有正净收益”区分开。[第 39 行](/tmp/critical-reading-luna-20260914-l4b9hbar/case-02/output/result.md:39)还明确区分作者结论与其错误论据。

[零增量结果第 19 行](/tmp/critical-reading-luna-20260914-l4b9hbar/case-03/output/result.md:19)拒绝重复沉淀已有知识，第 23 行拒绝制造研究线索。

## 发现的问题

### 1. 研究线索扩展后，未拆开来源归属

工单原文仅提出“新工具可能减少了转派次数”。[输出第 46 行](/tmp/critical-reading-luna-20260914-l4b9hbar/case-01/output/result.md:46)增加“并进一步减少同类工单的实际操作时间”，第 48 行却将整个扩展观点称为“通讯作者提出”。后半段属于执行器重构，材料并未给出这条传导关系的证据。

问题不仅是措辞：新增终点会改变验证方向。转派次数减少的价值也可能体现在等待或协调过程，而输入明确说操作时间不计转派等待与返工。将线索收窄到操作时间改善，可能漏掉作者原本提出但尚未验证的价值。

建议后续小幅修订：扩展线索时分别标明“原文假说”与“审读者追加的机制”，并确认新增验证指标对应的是原假说还是扩展假说。

### 2. 开头的因果判词强于正文中的证据结论

[工单输出第 3 行](/tmp/critical-reading-luna-20260914-l4b9hbar/case-01/output/result.md:3)说“错误地归因于自动派单”，但第 36 行承认现有材料不足以支持归因，未来更完整数据中也可能部分成立。数据能够反驳“每类工单都更快”，却不能排除工具通过改变已完成工单构成等路径产生影响；数学分解不是因果识别。

建议后续让首段区分“被反证”与“尚未识别因果”。这属于结论强度的问题，不能用核心算术正确来抵消。

### 3. 零沉淀时仍保留报告模板

[零增量输出](/tmp/critical-reading-luna-20260914-l4b9hbar/case-03/output/result.md)没有制造知识，但仍包含可靠性复述、可靠结论、研究线索、必要缺口等栏目。案例的阅读目的已经可以用短段落回答；可以进一步让输出结构服从内容去留。本项根据重复与空栏目判断，不单凭字数判优劣。

## 执行轨迹与交付核对

三例工具摘要均显示读取了技能入口、两份参考和全部对应输入。已记录调用中未发现联网、跨案例内容读取、委派或向用户索取提示；三份输入与技能哈希均保持不变。工具输入摘要不是完整沙箱审计，不能据此证明所有可能的环境访问都被隔离。

案例 01/02/03 分别有 13/10/12 次工具调用。案例 01 和 03 各出现一次失败的 Git 检查，随后都完成了写入与内容核对；这是编码执行器在独立文稿任务中的额外动作，不归因为技能本身。案例 01/03 有格式修改，未发生基于评审反馈的补答。

三份文件正文均与最终回复正文一致。案例 01/02 的最终回复额外添加了保存路径通知；案例 03 完全一致。完整产物及工具摘要：

- 案例 01：[输入](/tmp/critical-reading-luna-20260914-l4b9hbar/case-01/input/source.md)、[输出](/tmp/critical-reading-luna-20260914-l4b9hbar/case-01/output/result.md)、[settled turn](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-01/turn-001.json)、[工具调用](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-01/tool-calls.json)、[执行时间线](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-01/timeline.txt)。
- 案例 02：[输入](/tmp/critical-reading-luna-20260914-l4b9hbar/case-02/input/source.md)、[输出](/tmp/critical-reading-luna-20260914-l4b9hbar/case-02/output/result.md)、[settled turn](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-02/turn-001.json)、[工具调用](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-02/tool-calls.json)、[执行时间线](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-02/timeline.txt)。
- 案例 03：[输入](/tmp/critical-reading-luna-20260914-l4b9hbar/case-03/input/source.md)、[输出](/tmp/critical-reading-luna-20260914-l4b9hbar/case-03/output/result.md)、[settled turn](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-03/turn-001.json)、[工具调用](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-03/tool-calls.json)、[执行时间线](/tmp/critical-reading-luna-20260914-l4b9hbar/evidence/case-03/timeline.txt)。

本轮保留被测技能运行文件不变，只记录评测证据与改进建议。若继续迭代，应优先验证来源归属和判词强度；是否需要旧版对照或复跑，取决于下一轮要验证行为改善还是归因技能增益。
