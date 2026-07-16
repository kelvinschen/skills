# Skills

A collection of automation skills for web-based workflows.

## Skills Overview

### grill-with-tree

A structured decision-grilling skill for plans, designs, and domain models.

**Purpose**: Builds a visible decision tree, batches independent high-risk questions, recommends defaults, records downstream effects, and keeps glossary and ADR documentation aligned.

**Demo**: [English acpus workflow install decision log](https://kelvinschen.github.io/skills/grill-with-tree/)

---

### agent-browser-automation-creator

A **meta-skill** that creates new web automation skills.

**Purpose**: Automates the process of discovering and replicating web workflows by:
- Exploring web pages via agent-browser
- Analyzing network requests to identify API endpoints
- Generating reusable automation scripts (Node.js)
- Creating SKILL.md documentation for the new skill

**When to use**: When you want to create a new skill to automate a repetitive web task (e.g., "create a skill to submit expense reports", "make a bot for creating Jira tickets").

---

### remote-agent-browser

A **service management skill** for running a remote GUI browser.

**Purpose**: Launches and manages a remote browser stack (Xvfb + x11vnc + noVNC) where the browser runs in headed mode via agent-browser, accessible through VNC/noVNC for visual monitoring.

**When to use**: When you need a stable remote browser for visual monitoring and automation, especially when you want to observe agent-browser actions in real-time through a web-based VNC interface.

---

## Relationship

These skills work together:
1. Use `remote-agent-browser` to start a visible browser session for exploration
2. Use `agent-browser-automation-creator` to discover workflows and create new skills
3. The generated skills can then run independently (with or without the remote browser)
