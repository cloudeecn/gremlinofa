# Contributing to GremlinOFA

Thanks for considering a contribution to this vibe-coded project. We're genuinely excited when it works, and even more excited when someone else makes it work better.

## Reporting Bugs

Found something broken? Open an issue with enough detail that someone can reproduce it without playing detective. Think of it like briefing an AI coding assistant — because that's probably what's going to fix it.

**A good bug report includes:**

- What you expected to happen
- What actually happened
- Steps to reproduce (the more specific, the better)
- Browser, OS, and any relevant environment details
- Console errors if you've got them

The more context you provide, the faster Cline (or a human, we exist too) can get to work.

## Suggesting Features

Got an idea? Same deal — write it up with enough detail that it could be dropped straight into a prompt. Explain the use case, the expected behavior, and if you're feeling generous, some thoughts on implementation.

We can't promise every feature request will ship, but we read them all.

## Pull Requests

Here's the preferred path: fire up your own Cline, implement the thing, and submit a PR. Vibe-coded contributions are very much welcome.

### Getting Started

```bash
git clone <your-fork>
cd gremlinofa
npm install
```

Check out [`development.md`](development.md) for architecture details, data model, and the full feature checklist.

### Before You Submit

Run the checklist:

```bash
# Type check, lint, format check
npm run verify

# Run tests (minimal output)
npm run test:silent
```

All checks should pass. If you're adding a feature, add tests. If you're fixing a bug, a test that would have caught it is appreciated.

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Update docs if your change affects user-facing behavior
- Describe what you changed and why in the PR description

## Code Style

We use ESLint and Prettier. Run `npm run verify` and it'll tell you if something's off. TypeScript strict mode is enabled — avoid `any` unless you have a really good reason.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 license.
