type HandoffPromptOptions = {
  targetPath: string;
  memoryPath: string;
  nextFocus: string;
  extraMarkers?: string;
};

export function handoffPrompt(options: HandoffPromptOptions): string {
  const extraMarkers = options.extraMarkers || "";
  return `编写一份 handoff document，总结此 node 的工作，以便新的 agent 可以从这里继续。
保存到：${options.targetPath}
如果 parent directory 不存在，请创建它。

同时向 shared flow memory file 追加一条 compact index entry：
${options.memoryPath}

使用此 flow memory entry format：
## <node> - <short status>
- Status/verdict:
- Key results:
- Changed/relevant files:
- Checks:
- Findings:
- Handoff file: ${options.targetPath}
- Next focus:

包含一个 " 推荐的 skills" section，列出下一个 agent 应调用的 skills。
不要重复其他 artifacts 中已捕获的内容，例如 PRDs、plans、ADRs、issues、commits、diffs、logs 或 test outputs。改为通过 path 或 URL 引用它们。
遮盖 sensitive information，例如 API keys、passwords、tokens、secrets 或 personally identifiable information。
根据此 next focus 调整 handoff：${options.nextFocus}
保持 handoff 和 memory entry 简洁。不要包含 step-by-step internal monologue、大段 logs、完整 diffs 或完整 test output；改为引用 paths。

尽可能用以下 handoff marker lines 结束响应。它们能改进 flow summaries，但即使遗漏 markers，响应本身也仍应是有用的 handoff：
HANDOFF_PATH: ${options.targetPath}
HANDOFF_SUMMARY: <compact summary>${extraMarkers}`;
}

export function independentTestingGuidance(): string {
  return `不要把 implementation agent 的 testing claims 当作充分证据。检查 workspace，运行 black-box 或 regression checks，并在有用时创建临时 test scripts 或 fixtures。你有 permission 运行 commands 和创建 test artifacts，但不要进行 unrelated production code changes。如果必须修改 test files 或 fixtures，请准确说明修改了什么。

返回：
- commands/actions run
- pass/fail verdict
- observed output
- suspected cause if failed
- residual risk`;
}

export function testVerdictMarkerPrompt(): string {
  return `以下 verdict marker 会驱动 flow routing。请在响应末尾准确包含其中一行 marker：
TEST_VERDICT: pass
或
TEST_VERDICT: fail`;
}

export function validationReviewGuidance(options: { finalRound?: boolean } = {}): string {
  const finalRoundGuidance = options.finalRound
    ? "\n对于 final validation round，仅在存在 unresolved P0/P1 或 unknown validation state 时使用 FINAL_VERDICT: needs_human_orchestrator_decision。"
    : "";
  return `运行 task-focused validation 和 focused implementation review。在此 validation phase 不要编辑 production code；改为报告 issues，供下一 fix phase 处理。

从 git diff --stat、changed files、implementation handoff、plan scope，以及与任务相关的 tests 或 checks 开始。不要执行 full repository audit 或 broad monorepo scan。只有当这些 task-related signals 显示风险时才深入检查。

Severity rubric：
- P0：must-fix blocker，例如 security/privacy/data loss、deterministic crash、required validation failure，或 explicit user must-have 被破坏。
- P1：应在此 flow 中考虑的 high-impact correctness regression 或 critical test gap。
- P2：medium-risk edge case、maintainability issue 或有用的 coverage improvement；对 routing 仅作信息参考。
- P3：low-risk nit、style、docs 或 optional cleanup。

返回 validation commands/actions、results 和 findings。先列出 P0/P1 findings。保持 P2/P3 简洁。如果没有 blocking findings，请明确说明并提及 residual risk。
仅对真实 P0 findings、失败的 task-relevant checks，或应在此 flow 中修复的 P1 findings 使用 VALIDATION_VERDICT: fix。单独的 P2/P3 不得产生 VALIDATION_VERDICT: fix。${finalRoundGuidance}
包含 compact handoff，并通过 path 引用 detailed artifacts，不要复制大段 logs 或 diffs。遮盖 secrets 和 sensitive personal data。`;
}

export function validationVerdictMarkerPrompt(options: { finalRound?: boolean } = {}): string {
  if (options.finalRound) {
    return `以下 final verdict marker 会驱动 flow routing 和 summary。请在响应末尾**准确包含**其中一行 marker：
FINAL_VERDICT: pass
或
FINAL_VERDICT: needs_human_orchestrator_decision`;
  }
  return `以下 validation verdict marker 会驱动 flow routing。请在响应末尾**准确包含**其中一行 marker：
VALIDATION_VERDICT: pass
或
VALIDATION_VERDICT: fix`;
}
