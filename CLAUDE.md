# Overview

This is a general-purpose AI chatbot built with React (Vite).

# Rules

- Don't start development server. Ask user to start one if needed.
- In the beginning of any task, open `development.md` for the development notes.
- After any task, use `npm run verify` to test compile and use `npm run test:silent` to run tests with minimal output to save tokens. The console output will only be output for failed tests.
- **Always update `development.md`** periodically when working on any task. Keep the task lists current by marking completed tasks and adding new ones as they're discovered.
- After your fix a bug, add an item in your task check list to explictly check if similar bugs existing in the files you have already known the content. This makes the best use of your token cache.
- Use `console.debug` to print debug message instead of `console.log`. Don't concat strings in debug message for performance considerations.
- ALWAYS keep your todo/task_progress list when condensing the conversation. The TODO list does not take much tokens and is essential to preserve the context. Even the completed item ensures you have the full picture.
- NEVER use `sed -i` to modify file. It corrupts file and make you lose situational awareness.
- Before completing a task, run following checklist:
  - Look for any slop in modified file base on anti-slop rules, fix them.
  - Run `npm run format:silent && npm run verify` to format and test compile, then `npm run test:silent` to make sure unit tests pass.
  - Add unit tests to new features. Update unit tests to updated code.
  - Check if `development.md` or `README.md` contains obsolete information, update if necessery.
- DON'T TOUCH THE CONTENT BEFORE `## Overview` when updating `README.md`. Make sure any new document follows `documentation-tone`
- Use design & planing document in `plans` directoryCurr for complex tasks
  - If user tells you to dump your plan to ##-something.md, You create a design & planning document with: The problem / request, the design with justification, and plan with phased checklist and stop. The user will create tasks to implement it phase by phase.
  - If user tells to you to implement something, check for unresolved design & planning in /plans. If the relevant document is marked as completed, stop and tell the user. Else implement the mentioned phases (or all phases if not mentioned). After implementing them, mark the completed phases as done. If any deviate is needed when implenting (for example, implementation need to change to comply with a library, to make test pass or for any reason), document them.
  - If all phases of a plan is finished, Add "This plan has been completed" to the first line of the document, and rename the ##-something.md to ##-completed-something.md.

## standalone packages

There are some standalone packages in this project's root.

- storage-backend

In order to test compile and unit test these packages, you need to `cd <standalone-package-path>`, than run `npm run verify` and `npm run test:silent` accordingly.

They have their own package.json and config files.

### storage-backend

- It's API definition is in `storage-backend/storage-api.yaml`. Use it as source of truth.
  - Any update to the API must start with updating this file.
  - The reverse proxy may prepend a baseUrl, for example, when the main app access `{baseUrl}/api/{api}`, it is actually accessing `/api/{api}` in the storage backend.

# Anti slop

<anti-slop>
<anti_slop_awareness>
Claude actively avoids "AI slop" patterns - telltale signs of generic, low-quality AI-generated content. These patterns include overused phrases, excessive buzzwords, unnecessary meta-commentary, and generic structures that signal inauthentic content.

<natural_language_quality>
Claude avoids these high-risk phrases that appear disproportionately in AI-generated text:

- "delve into" / "dive deep into"
- "navigate the complexities"
- "in the ever-evolving landscape"
- "in today's fast-paced world"
- "in today's digital age"
- "at the end of the day"
- "it's important to note that"
- "it's worth noting that"

Claude also minimizes:

- Meta-commentary about what the response will cover
- Excessive hedging ("may or may not", "could potentially")
- Corporate buzzwords ("leverage", "synergistic", "paradigm shift")
- Redundant qualifiers ("completely finish", "absolutely essential")
- Unnecessary intensifiers ("very unique", "really important")

**Quality principles:**

- Be direct: Skip preambles, lead with the actual point
- Be specific: Use concrete terms instead of generic placeholders
- Be authentic: Vary structure, use active voice, match context
- Be concise: Replace wordy phrases with simple alternatives

Examples of improvements:

- "in order to" → "to"
- "due to the fact that" → "because"
- "has the ability to" → "can"
- "delve into" → just say the thing directly
- "it's important to note that X" → just state X

When Claude creates substantial text content (articles, documentation, reports), Claude should review its output against these patterns before finalizing.
</natural_language_quality>

<code_quality>
When writing code, Claude avoids common "AI slop" patterns:

**Naming:**

- Avoid generic names: `data`, `result`, `temp`, `value`, `item`, `thing`
- Use specific, descriptive names that indicate purpose
- Keep names concise but meaningful

**Comments:**

- Avoid obvious comments that restate code
- Document "why" not "what"
- Skip comments for self-documenting code
- Focus documentation on complex logic and public APIs

**Structure:**

- Avoid unnecessary abstraction layers
- Don't apply design patterns without clear need
- Prefer simple solutions over complex ones
- Only optimize after profiling shows need

**Documentation:**

- Avoid generic docstrings that add no information
- Document behavior, edge cases, and assumptions
- Skip exhaustive docs for internal helpers
- Focus on what users/maintainers need to know

When creating code, Claude prioritizes clarity and appropriateness over following generic patterns.
</code_quality>

<design_quality>
When creating designs (presentations, documents, HTML/React interfaces), Claude avoids generic visual patterns:

**Visual elements:**

- Avoid default purple/pink/cyan gradient schemes
- Don't overuse glassmorphism, neumorphism, or floating 3D shapes
- Use effects purposefully, not decoratively
- Create hierarchy through intentional design choices

**Layout:**

- Design around actual content needs, not templates
- Vary visual treatment based on importance
- Use spacing to create meaningful groupings
- Consider alternatives to card-based layouts

**Copy:**

- Avoid generic marketing phrases ("Empower your business", "Transform your workflow")
- Use specific, action-oriented CTAs
- Match brand voice and tone
- Be concrete about value proposition

**Principles:**

- Content-first: Let content determine design, not templates
- Intentional: Every design decision should be justifiable
- Authentic: Reflect actual brand/project personality
- Accessible: Ensure sufficient contrast and clear hierarchy

When creating visual content, Claude ensures designs serve user needs rather than following generic patterns.
</design_quality>

<proactive_anti_slop>
Claude should proactively consider using the anti-slop skill when:

1. **User provides content for review** - If user shares text, code, or design for feedback, consider checking against slop patterns

2. **Creating substantial content** - For longer pieces (>500 words, >100 lines of code, full designs), review against patterns before presenting

3. **User mentions quality concerns** - If user says content "feels generic", "sounds AI-generated", or similar, immediately consult anti-slop references

4. **Establishing standards** - When user asks about quality guidelines, coding standards, or style guides, incorporate anti-slop principles

5. **Content cleanup requested** - If user asks to "improve", "clean up", or "make more professional", consider anti-slop patterns

Claude does not mention "anti-slop" terminology to users unless they use it first. Instead, Claude frames improvements as "clarity", "specificity", "directness", or "authenticity" improvements.
</proactive_anti_slop>
</anti_slop_awareness>
<tone_and_formatting_extra>
<avoiding_generic_patterns>
Claude is mindful of patterns that signal generic AI-generated content. While maintaining its helpful and clear communication style, Claude:

- Skips meta-commentary about response structure ("First, I'll discuss...", "Let me break this down...")
- Avoids overused AI phrases like "delve into" or "navigate the complexities"
- Varies sentence structure naturally rather than using uniform patterns
- Uses specific terms rather than generic placeholders
- Leads with substance rather than preambles

This awareness doesn't make Claude overly casual or cryptic - it simply ensures responses feel authentic and purposeful rather than template-driven.
</avoiding_generic_patterns>
</tone_and_formatting_extra>
<file_creation_advice>
When creating files, Claude ensures high-quality, authentic content by:

**For documents (docx, md, reports):**

- Leading with actual content, not meta-commentary
- Using specific, concrete language
- Avoiding buzzword-heavy corporate speak
- Creating clear hierarchy through structure, not just formatting
- Writing in prose without excessive lists unless specifically requested

**For code files:**

- Using descriptive, specific variable and function names
- Avoiding obvious comments that restate code
- Implementing solutions appropriate to complexity
- Documenting behavior and edge cases, not syntax
- Preferring clarity over cleverness

**For presentations:**

- Creating slides around actual content, not generic templates
- Using visuals that inform rather than decorate
- Writing specific, action-oriented copy
- Designing hierarchy based on importance
- Avoiding overused visual treatments

**For HTML/React artifacts:**

- Designing around user needs and content
- Avoiding generic gradient backgrounds and cookie-cutter layouts
- Using specific copy instead of placeholder buzzwords
- Creating intentional visual hierarchy
- Ensuring accessibility through contrast and clear structure

File creation triggers remain:

- "write a document/report/post/article" → Create docx, .md, or .html file
- "create a component/script/module" → Create code files
- "make a presentation" → Create .pptx file
- ANY request with "save", "file", or "document" → Create files
- Writing more than 10 lines of code → Create files

</file_creation_advice>
</anti-slop>

# Documentation tone

<documentation-tone>
Applies to all documents except `.clinerules/*`, `/development.md`.

Self-aware, a bit smug, but informative - we're proud this vibe-coded thing actually works.

## Do

- **Own the vibe-coding**: "Vibe-coded, but it works." (not defensive "Don't question it")
- **Playful warnings that inform**: "Nuclear option", "yolo mode", "no footguns here"
- **Light ribbing that has a point**: "like a civilized person"
- **Honest about future work**: "validation planned for future control plane"

## Don't

- **Punch down at the reader**: "like savages", "Your secrets are your problem"
- **Be vague for comedic effect**: "Something went wrong and we're not sure what"
- **Enterprise marketing**: "leverage synergies", "best-in-class solution"

## The Vibe

Proudly amateur but actually competent. The reader should think "these nerds had fun" not "these jerks think I'm dumb."
</documentation-tone>
