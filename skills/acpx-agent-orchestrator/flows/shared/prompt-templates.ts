type HandoffPromptOptions = {
  targetPath: string;
  nextFocus: string;
  extraMarkers?: string;
};

export function handoffPrompt(options: HandoffPromptOptions): string {
  const extraMarkers = options.extraMarkers || "";
  return `Write a handoff document summarizing this node's work so a fresh agent can continue from here.
Save it to: ${options.targetPath}
Create the parent directory if it does not exist.

Include a "suggested skills" section for skills the next agent should invoke.
Do not duplicate content already captured in other artifacts, such as PRDs, plans, ADRs, issues, commits, diffs, logs, or test outputs. Reference them by path or URL instead.
Redact sensitive information, such as API keys, passwords, tokens, secrets, or personally identifiable information.
Tailor the handoff to this next focus: ${options.nextFocus}

End your response with these marker lines:
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
  return `Include exactly one verdict marker line:
TEST_VERDICT: pass
or
TEST_VERDICT: fail`;
}

export function reviewGuidance(options: { finalRound?: boolean } = {}): string {
  const finalRoundGuidance = options.finalRound
    ? "\nFor the final review, use FINAL_VERDICT: needs_human_orchestrator_decision only for unresolved P0/P1 or unknown validation state."
    : "";
  return `Review the current working tree for bugs, regressions, missing tests, scope drift, and refactor safety. Do not edit files. Findings must include severity markers and concrete file references when possible.

Severity rubric:
- P0: must-fix blocker, such as security/privacy/data loss, deterministic crash, required validation failure, or an explicit user must-have that is broken.
- P1: high-impact correctness regression or critical test gap that should be considered for this flow.
- P2: medium-risk edge case, maintainability issue, or useful coverage improvement; informational for routing.
- P3: low-risk nit, style, docs, or optional cleanup.

Return findings first. If there are no blocking findings, say that clearly and mention residual risk.
Use REVIEW_VERDICT: fix only for true P0 findings or P1 findings that should be fixed in this flow. P2/P3 alone must not produce REVIEW_VERDICT: fix.${finalRoundGuidance}
Include a compact handoff and reference detailed artifacts by path instead of copying large logs or diffs. Redact secrets and sensitive personal data.`;
}

export function reviewVerdictMarkerPrompt(options: { finalRound?: boolean } = {}): string {
  if (options.finalRound) {
    return `Include exactly one final verdict marker line:
FINAL_VERDICT: pass
or
FINAL_VERDICT: needs_human_orchestrator_decision`;
  }
  return `Include exactly one review verdict marker line:
REVIEW_VERDICT: pass
or
REVIEW_VERDICT: fix`;
}

