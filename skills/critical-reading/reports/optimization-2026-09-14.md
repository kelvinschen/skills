# 评测问题落地与复验

日期：2026-09-14。针对[首轮基准评测](benchmark-2026-09-14.md)发现的来源归属、判词强度和零沉淀答复问题，修改技能运行文件，并开展两轮共五次 Luna 独立复验。

## 最终修改

- [入口的输出约定](../SKILL.md)：写正文前先选择答复形态。读者只需决定是否沉淀、又没有增量或关键问题时，直接给短结论；其他情况展开必要证据。明确首段和标题不得升级证据强度。
- [审读方法](../references/method.md)：分别判断被反证、尚未证实和论证不充分，最后核对首段、标题与正文的一致性；也防止把明确反证降格成笼统不确定。数学分解与因果识别分开处理。
- [沉淀约定](../references/retention.md)：来源归属落实到具体主张，尤其检查线索标题；新增环节或收益终点从原文假说中拆出。验证指标须对应原假说或明确的延伸，不能把下游未改善当成上游被证伪。

保持 Description、触发范围、两类沉淀的证据门槛及第一性原理分析主线不变。未加入针对工单或节电题目的答案模板。

## 第一轮复验：三例，未全部通过

[第一轮清单](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/manifest.json)保存技能快照、输入哈希、实际模型绑定及执行证据；[修改差异](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/runtime-changes.patch)记录该轮相对首轮基准的指令变化。

| 检查项 | 观察 |
|---|---|
| 判词强度 | 工单首段已分开“类别变快被反证”与“工具造成提速未被证明”，目标行为改善。 |
| 来源归属 | 仍用“减少转派，并改善真正的运营结果”作标题，再整体称为作者假说，部分通过。 |
| 零沉淀形态 | 删除了空栏目，但仍列出四项常识核验清单，未达到简短收口要求。 |
| 明确反证的回归保护 | 节电案例继续否定 20% 承诺，算出约 3.99% 上限和约 1.59% 净节电，未出现泛化的保守判词。 |

该轮在收齐结果后才修改指令，没有给执行器补提示或改写其输出。随后将答复形态选择前移，并将归属要求进一步落到标题与具体主张，只补验仍有缺陷的工单和零增量两例。

## 第二轮补验：两个目标行为改善

[第二轮清单](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/manifest.json)与[该轮修改差异](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/runtime-changes.patch)记录最终运行文件快照和补验条件。

**工单归属与判词。** [最终输出第 32 行](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/case-01/output/result.md:32)将作者假说明确限定为“新工具可能减少转派次数”，后续收益以条件推演表达，没有再把包含新终点的标题整体归给作者。第 34 行区分转派行为改变、操作时间或总工时改善与减员结论，避免用一个下游指标替代整条假说。

[首段](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/case-01/output/result.md:3)指出类别提速被数据直接否定；[第 26 行](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/case-01/output/result.md:26)将工具造成约 21% 提升保留为尚未证实，没有从描述性分解越界宣布排除工具作用。约 20.69% 的复算及构成变化分析保持正确。

**零增量答复。** [最终输出](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/case-03/output/result.md)为一个标题与一个结论段，交代可信度、与已有知识重合、没有新增条目及材料边界，不再输出核查清单、空栏目或无关研究议程。段内仍概括了原文内容，还能更简练；本次确认的是答复形态与去留决策改善，不宣称文字已最精简。

节电案例未在第二轮再次运行：第二轮只修改归属与答复形态，判词校准逻辑未变；它的行为证据来自第一轮复验，不能标作最终快照的全量回归结果。

## 执行证据与限制

五次均使用 Acpus、项目内临时 Luna 预设、新目录、新会话、单 Agent、单请求。输入文件与提示词和首轮基准逐字一致，未注入旧结果、评审标准或修复提示。两轮审查标准均在提交前冻结；第二轮沿用第一轮标准。它们是针对已观察缺陷的回归，不是新的盲测。

每次均在一次 Summary 后等待实际完成，再读取 Timeline、已结束回合记录和模型调用定义。五次记录均确认 `gpt-5.6-luna`、首次尝试、一个回合、读取技能入口及两份参考；输入与技能副本的哈希均未变化。没有记录到联网、跨案例内容读取、委派或向用户索要提示。输入隔离仍是独立目录与提示约束，不是安全沙箱证明。

五次均未提供 `sessionProjectionPath`，没有完整 ACP 会话投影。已保存的工具摘要与完整回复足以支持上述可观察行为判断，但不用于推断不可见的内部过程。

第一轮节电案例的落盘与最终回复存在数学定界符转义差异，数值及判断一致；因此未将其交付判为逐字一致。其余正文一致，第二轮工单最终回复额外包含保存路径通知。第二轮工单出现一次失败的 Git 检查后正常完成，未触发重试或干预。

复验输出与已结束回合记录：

- 第一轮工单：[输出](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/case-01/output/result.md)、[回合记录](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/evidence/case-01/turn-001.json)。
- 第一轮节电：[输出](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/case-02/output/result.md)、[回合记录](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/evidence/case-02/turn-001.json)。
- 第一轮零增量：[输出](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/case-03/output/result.md)、[回合记录](/tmp/critical-reading-luna-recheck-20260914-q7ngsdir/evidence/case-03/turn-001.json)。
- 第二轮工单：[输出](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/case-01/output/result.md)、[回合记录](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/evidence/case-01/turn-001.json)。
- 第二轮零增量：[输出](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/case-03/output/result.md)、[回合记录](/tmp/critical-reading-luna-recheck2-20260914-kzlu33w_/evidence/case-03/turn-001.json)。

最终静态结构、资源边界和文档引用检查通过；入口与界面元数据的工具启发式估算为 502 个词元，不代表模型分词实测。触发元数据未改，本轮没有重复运行触发检查。

本批支持这些冻结案例中的目标行为改善。单次前后比较不能排除采样因素，未验证跨领域稳定性、复杂长文和开放互联网取证，不将结果外推为全部任务均可靠。
