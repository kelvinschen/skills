# Visualization Rules

Visualize information that helps readers understand structure, mechanism, comparison, or evidence. Do not add decorative charts that are not grounded in the article.

## What to Visualize

- **Architecture relationships**
  - Use module diagrams, layered diagrams, dependency maps, or data-flow diagrams.
  - Show boundaries, ownership, inputs/outputs, and critical handoffs.

- **Process and mechanism**
  - Use pipelines, sequence diagrams, state machines, swimlanes, or stepper views.
  - Show trigger, transformation, decision points, feedback loops, and terminal states.

- **Cause and effect**
  - Use causal chains, fishbone-like groupings, or before/after mechanism diagrams.
  - Make assumptions and caveats visible near the relevant link.

- **Data and results**
  - Use bar charts for category comparison, line charts for trends, scatter plots for tradeoffs, and tables for exact benchmark conditions.
  - Always include units, sample size or workload when available, and source caveats.

- **Concept relationships**
  - Use term maps, boundary tables, layered definitions, or "confused with / differs from" comparisons.
  - Keep terminology consistent between Chinese and English.

- **Code and algorithms**
  - Use syntax-highlighted blocks, pseudocode, call stack diagrams, input/output cards, or highlighted execution paths.
  - Only include code that supports the article's reasoning.

## Minimum Visualization Set

When source material permits, include at least:

- One structural or mechanism diagram.
- One secondary visual: data chart, comparison matrix, concept map, code walkthrough, or tradeoff table.

If the article lacks enough structure for two visuals, include a note in the HTML explaining why the page uses a lighter visual treatment.

## Mermaid, Charts, and Fallbacks

- Mermaid is appropriate for flowcharts, sequence diagrams, state diagrams, architecture maps, and timelines.
- Chart.js or D3 is appropriate for benchmark results, comparisons, and trends.
- For every diagram/chart, include a nearby plain-language summary in Chinese.
- If using CDN libraries, ensure the raw Mermaid text, data table, or fallback summary remains readable if rendering fails.

## Source Discipline

- Do not invent numbers, components, dates, benchmark names, or relationships.
- If a diagram is inferred from prose, label it naturally, for example: "这张图按文中的描述整理".
- Preserve uncertainty visually: dashed lines, "可能", "取决于", "未说明", or caveat badges.
- Separate article claims from your explanatory framing.

## Common Patterns

- **Architecture post**: context map -> component diagram -> request/data flow -> tradeoff table.
- **AI/ML article**: pipeline -> model/data flow -> metric comparison -> limitation notes.
- **Benchmark article**: test setup -> results chart -> caveat matrix -> decision guide.
- **Tutorial**: stepper -> concept map -> code walkthrough -> troubleshooting table.
- **Research paper**: contribution map -> method pipeline -> result chart -> threat-to-validity notes.
