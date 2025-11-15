# Overview

This is a general-purpose AI chatbot built with React (Vite).

# Rules

- Don't start development server. Ask user to start one if needed.
- In the beginning of any task, open `/development.md` for the development notes.
- After any task, use `npm run verify` to test compile and use `npm run test:silent` to run tests with minimal output to save tokens. The console output will only be output for failed tests.
- **Always update `development.md`** periodically when working on any task. Keep the task lists current by marking completed tasks and adding new ones as they're discovered.
- After your fix a bug, add an item in your task check list to explictly check if similar bugs existing in the files you have already known the content. This makes the best use of your token cache.
- Use `console.debug` to print debug message instead of `console.log`. Don't concat strings in debug message for performance considerations.
- ALWAYS keep your todo/task_progress list when condensing the conversation. The TODO list does not take much tokens and is essential to preserve the context. Even the completed item ensures you have the full picture.
- NEVER use `sed -i` to modify file. It corrupts file and make you lose situational awareness.
- Before completing a task, run following checklist:
  - Look for any slop in modified file, fix them.
  - Run `npm run verify` to test compile and `npm run test:silent` to make sure unit tests pass.
  - Add unit tests to new features. Update unit tests to updated code.
  - Check if `development.md` or `README.md` contains obsolete information, update if necessery.
- VERY IMPORTANT: Whenever you see `Context Window Usage` in a message goes beyound 150k (150,000), IMMEDIATELY STOP what are you doing and use `ask_followup_question` tool to ask user to use `/smol` command to compact the context window.
- DON'T TOUCH THE CONTENT BEFORE `## Overview` when updating README.md

## standalone packages

There are some standalone packages in this project's root.

- storage-backend

In order to test compile and unit test these packages, you need to `cd <standalone-package-path>`, than run `npm run verify` and `npm run test:silent` accordingly.

They have their own package.json and config files.

### storage-backend

- It's API definition is in `storage-backend/storage-api.yaml`. Use it as source of truth.
  - Any update to the API must start with updating this file.
  - The reverse proxy may prepend a baseUrl, for example, when the main app access `{baseUrl}/api/{api}`, it is actually accessing `/api/{api}` in the storage backend.
