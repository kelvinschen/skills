# Page Patterns

Use these patterns when generating the HTML page. Default to a Chinese-first reading dashboard with medium-high density.

## Information Architecture

Use this order unless the article demands a different reading path:

1. **Hero dashboard**
   - Chinese title adapted from the article title.
   - Source title, author/date if available, article type, and reading time estimate.
   - One-sentence thesis and 3-5 key takeaways.
   - Primary visual preview: system map, pipeline, cause-effect chain, or data snapshot.
   - Compact navigation to the main sections.

2. **Article map**
   - Show how the article is organized: problem -> mechanism -> evidence -> tradeoffs -> conclusion.
   - Use chips, stepper, or mini graph rather than a plain table of contents when possible.

3. **Core mechanism sections**
   - Each section should combine: Chinese explanation, visual element, source/original expander, and caveats.
   - Keep paragraphs short. Prefer visual grouping over long prose.

4. **Source and comparison**
   - Use cards or inline expanders for source snippets, but label them in natural reader-facing language.
   - Use comparison tables for alternatives, before/after states, tradeoffs, or benchmark conditions.

5. **Code/API/implementation details**
   - Include code only when it carries technical meaning.
   - Pair code with callouts that explain inputs, outputs, invariants, or performance implications.

6. **Closing synthesis**
   - Restate the article's conclusion, practical implications, unresolved questions, and source limitations.
   - Include a concise source note with URL, publication date, retrieval date if available, and any source limitations in plain language.

## Layout Defaults

- Desktop: use a main content column with a sticky side rail or top rail for navigation, source references, and terminology.
- Mobile: collapse navigation into a top segmented control or details menu; keep original text expanders inline.
- Avoid nested cards. Use cards for repeated items, source snippets, comparison cells, and focused tools.
- Use constrained widths for prose and wider bands for diagrams/tables.
- Keep important visualizations above the midpoint of the page.

## Density Control

- Aim for medium-high density: each viewport should contain one meaningful idea plus a navigation or source/detail affordance.
- Use compact cards, tabs, accordions, and inline expanders to avoid long uninterrupted prose.
- Do not crowd charts with decorative labels. Put exact values in tooltips or companion tables.
- Use whitespace to separate sections, not to create a low-density landing page.
- Avoid marketing hero layouts; this is an analysis surface, not a product landing page.

## Bilingual Placement

- Default: Chinese first.
- Put original English in local expanders next to the translated or summarized claim.
- Use side-by-side original/translation only for short, high-value excerpts where exact wording matters.
- For long articles, include a source/original rail or section listing the key snippets, not the entire article.
- Preserve original technical identifiers, API names, model names, version numbers, and quoted benchmark names.

## Voice and Microcopy

- Keep all visible page copy human and editorial. The page should feel written for readers, not emitted from a checklist.
- Avoid internal workflow, audit, validation, extraction, or fidelity terminology in visible page copy.
- Prefer labels such as "原文怎么说", "展开英文原句", "作者的表述", "出处", "来源", "相关段落", "完整上下文".
- If the page is selective rather than a full translation, phrase it naturally: "这页先抓住文章的主线、机制和取舍；需要完整语境时可以回到原文。"
- If source metadata is missing, write a short reader-facing note: "原页面没有显示作者信息，因此这里保留发布方名称。"

## Required Page Signals

- The first viewport must answer: what is the article about, why it matters, and how to read the page.
- The page must include at least two visualization types when source material supports them.
- The page must include at least three source/original text controls with natural labels.
- Every chart or diagram must have a text fallback summary near it.
