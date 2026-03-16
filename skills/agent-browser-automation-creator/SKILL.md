---
name: agent-browser-automation-creator
description: Create new agent-browser automation skills by exploring web pages and analyzing network requests. Use when the user wants to automate a web-based task, create a skill for repetitive web workflows, or extract and replicate API flows from websites. Triggers on requests like "create a skill to automate X on website Y", "make a bot for Z web task", "extract the API flow from this site", or "I want to automate this web workflow".
---

# Agent Browser Automation Creator

This is a meta-skill that creates new skills. It uses agent-browser to explore web pages, discover workflow paths, analyze network requests, and generate reusable automation scripts.

## When to use

The user wants to create a new skill for web automation. They'll provide:
- A webpage URL (or imply one from context)
- A description of the task/goal to accomplish

## Prerequisites

1. `agent-browser` CLI must be available
2. User must have an authenticated session via agent-browser (SSO logged in, cookies present)
3. Node.js must be available for running generated scripts

## Workflow

### Phase 1: Understand the Task

1. Confirm the target URL and task description with the user
2. Ask clarifying questions if the task is ambiguous:
   - What's the expected output? (e.g., "return a URL", "create a resource and return its ID")
   - Are there specific form fields or inputs required?
   - Should the automation be via API calls or UI interactions?

### Phase 2: Explore and Discover

1. **Open the page**: Use agent-browser to navigate to the target URL
   ```bash
   agent-browser open <url>
   agent-browser wait --load networkidle
   ```

2. **Take a snapshot**: Understand the current page state
   ```bash
   agent-browser snapshot -i
   ```

3. **Identify the task path**: Based on the task description, determine what UI interactions are needed:
   - Look for buttons, forms, links related to the task
   - Plan the sequence of actions (click here, fill this, submit that)

4. **Explore autonomously**:
   - Use `agent-browser click`, `fill`, `type` to interact with elements
   - Take snapshots between actions to observe state changes
   - Continue until the task is completed successfully

5. **Capture network activity**: Throughout the exploration, network requests are being logged automatically. You'll analyze these in Phase 3.

### Phase 3: Analyze Network Requests

1. **List all requests made during exploration**:
   ```bash
   agent-browser network requests --json
   ```

2. **Filter for relevant API calls**:
   - Look for POST, PUT, DELETE requests (these are typically the action endpoints)
   - Look for requests to API paths (e.g., `/api/`, `/v1/`, `/graphql`)
   - Identify the requests that correspond to the task actions

3. **Extract key information from each relevant request**:
   - URL and endpoint
   - HTTP method
   - Headers (especially Authorization)
   - Request body/payload
   - Response structure

4. **Ask the user to confirm**: Present the discovered API flow and ask if this is the intended automation:
   ```
   I found this API flow:
   1. POST /api/resource → creates resource, returns ID
   2. POST /api/resource/{id}/action → performs action

   Headers needed:
   - Authorization: Bearer <token>

   Should I create a skill based on this flow?
   ```

### Phase 4: Generate the Automation Script

1. **Create a Node.js script** that:
   - Uses `agent-browser` CLI via child_process
   - Opens the page (to establish auth context)
   - Extracts necessary headers/cookies
   - Makes the API calls via `agent-browser eval` (fetch in browser context)
   - Returns the result as JSON

2. **Script structure** (follow the pattern from aime-create-task):
   ```javascript
   #!/usr/bin/env node

   const { execFileSync } = require('node:child_process');

   function run(args, input) {
     return execFileSync('agent-browser', args, {
       encoding: 'utf8',
       input,
       stdio: ['pipe', 'pipe', 'pipe'],
     }).trim();
   }

   function runJSON(args, input) {
     const out = run(args, input);
     try {
       return JSON.parse(out);
     } catch {
       throw new Error('Failed to parse JSON from: agent-browser ' + args.join(' '));
     }
   }

   function main() {
     // 1. Parse arguments
     const args = process.argv.slice(2);

     // 2. Open page to establish context
     run(['open', '<url>']);
     run(['wait', '--load', 'networkidle']);

     // 3. Extract auth headers from network requests
     const reqLog = runJSON(['network', 'requests', '--filter', '<api-path>', '--json']);
     const auth = /* extract from requests */;

     // 4. Make API calls via eval
     const code = '(async function() { /* fetch calls */ })();';
     const result = runJSON(['eval', '--stdin'], code);

     // 5. Output result
     console.log(JSON.stringify(result, null, 2));
   }

   try {
     main();
   } catch (error) {
     console.error('[skill-name] ' + error.message);
     process.exit(1);
   }
   ```

3. **Keep it minimal**: Focus on the happy path. Minimal error handling - just enough to catch and report issues.

4. **Make it executable**: The script should be a standalone executable Node.js file

### Phase 5: Create the SKILL.md

1. **Use this template**:
   ```markdown
   ---
   name: <skill-name>
   description: <What this skill does and when to use it. Be specific about triggers>
   ---

   # <Skill Name>

   ## When to use
   <Describe the use case and prerequisites>

   ## Preconditions
   1. User is already logged in (SSO/auth)
   2. agent-browser session has valid auth state

   ## Usage
   Run the script:
   \`\`\`bash
   ./<script-name>.js <arguments>
   \`\`\`

   ## Output
   <Describe the output format - JSON structure, return values>

   ## Validation
   <Describe what success looks like - status codes, URL patterns, etc.>

   ## Fallback flow (UI)
   If the script fails, describe the manual UI steps:
   1. snapshot -i
   2. <step-by-step UI interactions>
   ```

2. **Write clear instructions**: The SKILL.md should be self-contained and explain exactly how to use the skill

### Phase 6: Package the Skill

1. **Create skill directory structure**:
   ```
   <skill-name>/
   ├── SKILL.md
   └── <script-name>.js
   ```

2. **Choose a descriptive name**: The skill name should clearly indicate what it does (e.g., "create-jira-ticket", "submit-expense-report")

3. **Save to an appropriate location**:
   - If the user has a skills directory, use that
   - Otherwise, suggest a location and create it

4. **Report completion**:
   ```
   ✅ Skill created: <skill-name>

   Location: <path>

   Files:
   - SKILL.md (instructions)
   - <script-name>.js (automation script)

   To use: <brief usage example>
   ```

## Important Notes

### Exploration Strategy

- **Start broad**: Take snapshots, identify all interactive elements
- **Follow the path**: Focus on elements related to the task
- **Record everything**: Each interaction teaches you about the workflow
- **Verify success**: Confirm the task actually completed (URL changed, success message appeared, resource created)

### Network Analysis Tips

- **Filter strategically**: Use `--filter` with API paths to reduce noise
- **Look for patterns**: RESTful APIs follow patterns (`POST /resource`, `GET /resource/:id`)
- **Auth is critical**: Always extract Authorization headers - they're required for API calls
- **Watch the timing**: Requests happen after UI interactions - use this to correlate

### Script Generation Guidelines

- **Reuse auth**: Always extract auth from existing requests rather than hardcoding
- **Keep it simple**: Don't over-engineer - focus on the core workflow
- **Return useful data**: Include IDs, URLs, status codes in the output
- **Fail clearly**: Error messages should explain what failed and why

### Common Patterns

**Form submission**:
1. Fill form fields
2. Submit form
3. Capture POST request with form data
4. Script: make the POST request directly

**Multi-step workflow**:
1. Navigate to page
2. Click button → triggers POST → creates resource
3. Click another button → triggers another POST → performs action
4. Script: chain the POST requests in sequence

**Resource creation**:
1. POST to create resource → returns ID
2. GET to verify creation
3. Script: POST and return the created resource ID/URL

## Examples

**User request**: "Create a skill to submit an expense report on finance.company.com"

**Your workflow**:
1. Open finance.company.com
2. Snapshot → find "New Expense" button
3. Click it → observe page change
4. Fill form fields → observe POST request to `/api/expenses`
5. Submit → observe another POST
6. Extract auth header from requests
7. Generate script that makes the POST calls
8. Create SKILL.md with usage instructions
9. Package as "submit-expense-report" skill

**User request**: "Make a skill to create a GitHub issue"

**Your workflow**:
1. Open github.com/repo/issues/new
2. Snapshot → identify form fields (title, body, labels)
3. Fill a test issue → observe network requests
4. Extract the issue creation API endpoint
5. Generate script that POSTs to `/repos/:owner/:repo/issues`
6. Create SKILL.md
7. Package as "create-github-issue" skill

## Troubleshooting

**"No auth header found"**
- The page may not require auth, or auth is cookie-based
- Check for cookies instead of Authorization header
- Use `agent-browser eval` to make requests in the authenticated browser context

**"Multiple similar API endpoints"**
- Ask the user which endpoint is correct
- Show the URL, method, and payload for each
- Let the user choose the right one

**"UI interactions didn't trigger API calls"**
- Some actions are client-side only
- Look for the API calls that actually change server state
- Focus on POST/PUT/DELETE, not GET

**"Generated script fails"**
- Check if auth token expired
- Verify the endpoint URL is correct
- Ensure request payload matches what was captured
- Add better error reporting to the script

## Output Format

When creating a skill, report:

```
✅ Skill created successfully!

📁 Skill: <skill-name>
📂 Location: <path>

📄 Files created:
- SKILL.md
- <script-name>.js

🚀 Usage:
<pre>
<bash command to run the skill>
</pre>

📋 Output format:
<JSON structure or description>
```
