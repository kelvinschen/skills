# Interaction Rules

Use interaction to reveal detail, compare states, or trace source context. Interaction should make the article easier to understand, not hide essential information.

## Default Interactions

- **Section navigation**
  - Sticky desktop rail or compact top navigation.
  - Highlight the active section when practical.

- **Source/original text expanders**
  - Place naturally worded controls near key translated claims.
  - Good labels: "原文怎么说", "展开英文原句", "作者的表述", "相关段落", "出处".
  - Avoid mechanical labels that sound like an audit trail, extraction log, or internal checklist.
  - Show source snippet, section/paragraph label, and URL when available, but do not frame it like an audit log.
  - Keep snippets short; link out for full source when possible.

- **Diagram focus**
  - Allow clicking diagram legend items, cards, or steps to highlight related explanation.
  - Provide textual fallback for non-rendered diagrams.

- **Terminology tooltips**
  - Use tooltips or inline popovers for terms, acronyms, and translated technical phrases.
  - Include original English term where it matters.

- **Code/explanation toggles**
  - For code-heavy articles, allow switching between code, pseudocode, and explanation.
  - Keep the default view explanatory unless the article is primarily code.

## Medium-Depth Interactions

Use these when the source content benefits from them:

- Process playback for pipelines, request flow, or algorithms.
- Chart drill-down for benchmark dimensions, workloads, or environment variables.
- Comparison filters for alternatives, versions, architectures, or scenarios.
- Local view switches such as "机制 / 原句 / 影响" for dense sections.
- Expand/collapse depth controls: "快速读", "深入读", "看原句".

## Constraints

- Do not require a build step.
- Avoid interactions that depend on a backend, user account, or remote state.
- Avoid complex simulations unless the article itself is about a model, algorithm, or system that benefits from parameter exploration.
- Keep all controls keyboard reachable and visible enough for mobile use.
- Do not hide the main thesis or source context behind interaction.

## Implementation Guidance

- Use vanilla JavaScript for most interactions.
- Use small, explicit data structures in script tags for chart data, source snippets, and section metadata.
- Prefer `details/summary` for robust expanders when custom UI is unnecessary.
- Use ARIA labels for icon-only buttons and tabs.
- On mobile, convert side-by-side bilingual views into stacked blocks.

## Validation Checklist

- Click every navigation, expander, tab, filter, and playback control.
- Resize to mobile width and verify controls remain tappable.
- Confirm expanded original text does not push content into overlap.
- Confirm chart and diagram fallbacks remain meaningful if CDN scripts fail.
- Confirm no interaction changes the factual interpretation of the source.
