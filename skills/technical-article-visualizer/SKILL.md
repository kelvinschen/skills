---
name: technical-article-visualizer
description: Transform technical articles, papers, engineering blogs, architecture writeups, benchmarks, or pasted/URL article content into a Chinese-first, interactive, single-file HTML explainer with faithful extraction, visual diagrams, evidence links, optional original-language comparison, and automatic visual style selection. Use when Codex needs to analyze a technical article and produce a polished standalone HTML page rather than a plain summary.
---

# Technical Article Visualizer

## Overview

Use this skill to convert a technical article into a standalone HTML reading dashboard. Preserve the article's claims, caveats, and reasoning while making the core information easier to scan through visual structure, interaction, and selective translation.

Default output: Chinese-first, medium-high density, single-file HTML, automatic style choice, at least two useful visualizations, and expandable source/original-language snippets for key claims.

## Workflow

1. **Ingest and classify**
   - Identify source type: engineering blog, architecture post, tutorial, benchmark, paper, release note, or design doc.
   - Detect language, writing tone, technical depth, target audience, and article intent.
   - If the article is a URL and content is not provided, fetch or browse it when tools permit. If only a summary is available, mention the limitation in natural reader-facing language.

2. **Extract a faithful information model**
   - Capture thesis, problem, motivation, system context, key mechanism, tradeoffs, limitations, data/results, code/API details, and conclusion.
   - Preserve qualifiers such as "in this workload", "may", "under these assumptions", and version/date constraints.
   - Mark at least 3 high-value source anchors internally: paragraph labels, section names, direct source links, or short original excerpts.

3. **Choose the page pattern**
   - Default to a reading dashboard: hero summary, navigation, visual overview, main analysis sections, source/original text, and source notes.
   - Load `references/page_patterns.md` for layout requirements and density rules.
   - Keep the first viewport useful within 10 seconds: title, core thesis, article type, reading path, and one primary visual signal.

4. **Choose visualizations**
   - Prioritize structure and mechanism: architecture, flow, dependency, state, sequence, or cause-effect diagrams.
   - Add data charts, comparison tables, concept maps, or code walkthroughs when the article contains those signals.
   - Load `references/visualization_rules.md` before deciding the visualization set.

5. **Choose style automatically**
   - Infer tone from the article; do not ask the user to choose a style unless they explicitly request one.
   - Use designprompts.dev-style categories as inspiration, but express the style in your own concise design tokens.
   - Load `references/style_selection.md` for mapping rules.
   - Style affects visual language only; never change claims, hierarchy, or evidence to fit an aesthetic.

6. **Implement the single-file HTML**
   - Produce one complete `.html` file with semantic HTML, inline CSS, and inline JS.
   - CDN dependencies are allowed for Mermaid, Chart.js, D3, Lucide, or fonts when they materially improve the result.
   - Include graceful fallbacks: diagrams/charts should still have readable text summaries if CDN rendering fails.
   - Use responsive layout; verify no text, controls, diagrams, or bilingual panels overlap on mobile or desktop.

7. **Add interaction**
   - Default interactions: section navigation, expandable source/original text, diagram focus/highlight, terminology tooltips, and code/explanation toggles.
   - Add medium-depth interactions when useful: process playback, chart drill-down, comparison filters, or local view switches.
   - Load `references/interaction_rules.md` for interaction patterns and constraints.

8. **Self-check before final response**
   - Confirm the HTML is standalone and opens without a build step.
   - Confirm the page contains at least 2 visualization types and at least 3 source/original-text entry points.
   - Confirm English-source pages are Chinese-first, with only selected core content translated and original snippets available on demand.
   - Confirm the chosen style matches the article tone without reducing readability.
   - If using a browser or screenshot tool is available, visually inspect desktop and mobile widths.

## Translation Rules

- Default language is Chinese for headings, summaries, explanations, labels, and page controls.
- For English articles, translate only the core content included in the page: thesis, key mechanisms, important figures/tables, crucial caveats, and conclusion.
- Do not create a full paragraph-by-paragraph translation unless the user explicitly asks.
- Place original English behind natural controls near the translated claim, source card, or section.
- Keep technical terms stable: translate once, then show the English term in parentheses when it prevents ambiguity.

## Reader-Facing Voice

- Write page copy like a thoughtful technical editor, not like an agent explaining its procedure.
- Do not expose internal workflow, audit, validation, extraction, or fidelity terminology in visible page copy.
- Prefer natural labels: "原文怎么说", "文中这一段", "作者的表述", "展开英文原句", "来源", "出处", "关键原句", "相关段落".
- When explaining scope, say it in reader terms, for example: "这页聚焦文章最核心的机制和取舍，完整上下文可以回到原文阅读。"
- When a source is incomplete, say it plainly and briefly, for example: "原页面没有显示作者信息，因此这里保留发布方名称。"
- Keep provenance available, but avoid making the page feel like an audit log or a compliance checklist.

## Output Contract

The final artifact should include:

- A complete single-file HTML page.
- A Chinese-first reading dashboard with medium-high information density.
- Automatic visual style based on article tone.
- At least two appropriate visualization forms.
- At least three traceable source/original-text controls using natural labels.
- Responsive behavior for narrow mobile and desktop.
- A short final note to the user with the file path and any validation performed.

## References

- `references/page_patterns.md`: dashboard layout, density, bilingual placement, and page section patterns.
- `references/style_selection.md`: automatic style mapping and design token guidance.
- `references/visualization_rules.md`: what information to visualize and how to choose diagram/chart types.
- `references/interaction_rules.md`: interaction patterns for evidence, original text, diagrams, charts, and code.
