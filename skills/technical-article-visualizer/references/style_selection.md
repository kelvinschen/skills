# Style Selection

Choose style automatically from the article's writing tone, topic, and intended reader. Use designprompts.dev-style categories as inspiration, but write original CSS and concise style tokens.

## Selection Process

1. Identify tone: steady, academic, pragmatic, playful, experimental, urgent, futuristic, or editorial.
2. Identify domain: architecture, AI/ML, infrastructure, frontend, data, security, product engineering, research, or tutorial.
3. Pick one primary style and one restrained accent style.
4. Express the choice as CSS variables: color, typography, radius, shadow, border, chart palette, and motion.
5. Keep diagrams and text readable before adding decorative effects.

## Recommended Mappings

- **Steady enterprise / architecture / reliability**
  - Styles: Professional, Enterprise, Swiss, Monochrome.
  - Traits: light or neutral background, restrained accent color, strong grid, clear borders, compact tables, sans-serif typography.

- **AI / systems innovation / frontier tooling**
  - Styles: Modern Dark, Terminal, Kinetic, restrained Cyberpunk.
  - Traits: dark technical surface, monospace accents, glowing but controlled highlights, pipeline visuals, command/log-inspired labels.

- **Tutorial / practical explainer / lighter engineering blog**
  - Styles: Flat Design, Material, Clay, Playful Geometric.
  - Traits: friendly colors, rounded but not oversized surfaces, approachable icons, step-by-step cards, soft motion.

- **Research / paper / rigorous benchmark**
  - Styles: Academia, Newsprint, Swiss.
  - Traits: serif or scholarly headings, citation-like evidence markers, muted palette, precise tables and chart annotations.

- **Design / frontend / visual systems**
  - Styles: Bauhaus, Art Deco, Bold Typography, Swiss, Maximalism only when the source is expressive.
  - Traits: strong typography, layout rhythm, visual hierarchy, controlled contrast.

- **Infrastructure / CLI / developer tooling**
  - Styles: Terminal, Industrial, Monochrome, Modern Dark.
  - Traits: command panels, status indicators, dense logs, monospace labels, sharp separators.

## Guardrails

- Do not let style overpower diagrams, code, source evidence, or translation controls.
- Avoid one-note color palettes. Use a base, a text scale, one primary accent, one warning/contrast accent, and neutral surfaces.
- Avoid heavy gradients, decorative blobs, or vague stock-like imagery unless the article subject truly calls for it.
- Keep card radii moderate; use 8px or less unless the selected style specifically needs softer surfaces.
- Use motion for state changes, focus, reveal, and process playback; avoid constant distracting animation.
- Keep charts accessible: provide sufficient contrast, labels, and non-color distinctions when possible.

## Style Metadata in HTML

Include a compact comment near the top of the HTML:

```html
<!--
Style: Modern Dark + Terminal accents
Reason: The article explains a frontier AI system with implementation-oriented prose.
-->
```

This helps later agents revise the style without reverse-engineering the page.
