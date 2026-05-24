type HandoffPromptOptions = {
  targetPath: string;
  memoryPath: string;
  nextFocus: string;
  extraMarkers?: string;
};

export function handoffPrompt(options: HandoffPromptOptions): string {
  const extraMarkers = options.extraMarkers || "";
  return `Write a handoff document summarizing this node's work so a fresh agent can continue from here.
Save it to: ${options.targetPath}
Create the parent directory if it does not exist.

Also append a compact index entry to the shared flow memory file:
${options.memoryPath}

Use this flow memory entry format:
## <node> - <short status>
- Status/verdict:
- Key results:
- Changed/relevant files:
- Checks:
- Findings:
- Handoff file: ${options.targetPath}
- Next focus:

Include a "suggested skills" section for skills the next agent should invoke.
Do not duplicate content already captured in other artifacts, such as PRDs, plans, ADRs, issues, commits, diffs, logs, or test outputs. Reference them by path or URL instead.
Redact sensitive information, such as API keys, passwords, tokens, secrets, or personally identifiable information.
Tailor the handoff to this next focus: ${options.nextFocus}
Keep both the handoff and memory entry concise. Do not include step-by-step internal monologue, large logs, full diffs, or full test output; reference paths instead.

End your response with these handoff marker lines when possible. They improve flow summaries, but the response itself should still be a useful handoff if the markers are missed:
HANDOFF_PATH: ${options.targetPath}
HANDOFF_SUMMARY: <compact summary>${extraMarkers}`;
}

export function independentTestingGuidance(): string {
  return `Do not accept the implementation agent's testing claims as sufficient evidence. Inspect the workspace, run black-box or regression checks, and create temporary test scripts or fixtures if useful. You have permission to run commands and create test artifacts, but do not make unrelated production code changes. If you must modify test files or fixtures, say exactly what you changed.

Return:
- commands/actions run
- pass/fail verdict
- observed output
- suspected cause if failed
- residual risk`;
}

export function testVerdictMarkerPrompt(): string {
  return `The following verdict marker drives flow routing. Include exactly one of these marker lines at the end of your response:
TEST_VERDICT: pass
or
TEST_VERDICT: fail`;
}

export function validationReviewGuidance(options: { finalRound?: boolean } = {}): string {
  const finalRoundGuidance = options.finalRound
    ? "\nFor the final validation round, use FINAL_VERDICT: needs_human_orchestrator_decision only for unresolved P0/P1 or unknown validation state."
    : "";
  return `Run task-focused validation and a focused implementation review. Do not edit production code in this validation phase; report issues for the next fix phase instead.

Start with git diff --stat, the changed files, the implementation handoff, the plan scope, and task-relevant tests or checks. Do not perform a full repository audit or broad monorepo scan. Inspect deeper only where these task-related signals show risk.

Severity rubric:
- P0: must-fix blocker, such as security/privacy/data loss, deterministic crash, required validation failure, or an explicit user must-have that is broken.
- P1: high-impact correctness regression or critical test gap that should be considered for this flow.
- P2: medium-risk edge case, maintainability issue, or useful coverage improvement; informational for routing.
- P3: low-risk nit, style, docs, or optional cleanup.

Return validation commands/actions, results, and findings. Put P0/P1 findings first. Keep P2/P3 concise. If there are no blocking findings, say that clearly and mention residual risk.
Use VALIDATION_VERDICT: fix only for true P0 findings, failed task-relevant checks, or P1 findings that should be fixed in this flow. P2/P3 alone must not produce VALIDATION_VERDICT: fix.${finalRoundGuidance}
Include a compact handoff and reference detailed artifacts by path instead of copying large logs or diffs. Redact secrets and sensitive personal data.`;
}

export function validationVerdictMarkerPrompt(options: { finalRound?: boolean } = {}): string {
  if (options.finalRound) {
    return `The following final verdict marker drives flow routing and summary. **Include exactly** one of these marker lines at the end of your response:
FINAL_VERDICT: pass
or
FINAL_VERDICT: needs_human_orchestrator_decision`;
  }
  return `The following validation verdict marker drives flow routing. **Include exactly** one of these marker lines at the end of your response:
VALIDATION_VERDICT: pass
or
VALIDATION_VERDICT: fix`;
}
