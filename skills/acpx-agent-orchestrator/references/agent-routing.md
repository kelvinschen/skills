# Agent Routing

The orchestrator owns product judgment, decomposition, status, and final acceptance. Specialist agents own bounded work packets.

## Lanes

Planning lane:

- Purpose: turn ambiguous user intent into an implementation plan.
- Preferred agent: `aiden`.
- Fallback: `trae` only if `aiden` is unavailable.
- Permissions: `--approve-reads --no-terminal`.
- Required output: target behavior, files/modules likely touched, risks, test plan.

Implementation lane:

- Purpose: apply accepted code changes.
- Preferred agent: `trae`.
- Fallback: `aiden` only for bounded implementation tasks.
- Permissions: `--approve-all` after scope is accepted.
- Required output: change summary, tests run, unresolved issues.

Review lane:

- Purpose: find regressions, missed requirements, unsafe edits, and missing tests.
- Preferred agent: `aiden`.
- Fallback: `trae` in read-only mode.
- Permissions: `--approve-reads --no-terminal`.
- Required output: findings first, ordered by severity, with file references.

Verification lane:

- Purpose: run tests/builds and collect final evidence.
- Preferred agent: same as implementation lane.
- The orchestrator must still inspect final git state directly.

## Prompt Contracts

Planning prompt must include:

- User request.
- Relevant repo facts already discovered.
- Constraints: no edits, no commands that mutate tracked files, concise plan.

Implementation prompt must include:

- Accepted plan.
- Exact scope and out-of-scope items.
- Permission to edit only necessary files.
- Requirement not to revert unrelated user changes.
- Verification commands to run.

Review prompt must include:

- Summary of intended behavior.
- Current diff or instructions to inspect current working tree.
- Requirement to prioritize bugs and regressions over style.

## Parallelism

Use parallel agents only when work is independent:

- One planning lane can inspect architecture while another summarizes tests.
- One implementation lane per disjoint subsystem.
- Never let two implementation agents edit the same files at the same time.
- Run review after implementation, not concurrently with writes.

## Stop Conditions

Stop delegating and take back control when:

- An agent asks for product intent.
- Two consecutive prompts fail for the same lane.
- The agent wants to broaden scope beyond the accepted plan.
- The working tree has unexpected unrelated edits.
