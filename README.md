# TC AI PR Reviewer

AI Code Reviewer is a GitHub Action that leverages Lab45 AI API to provide intelligent feedback and suggestions on pull requests. This powerful tool helps improve code quality and saves developers time by automating the code
review process at Topcoder.

## Features

- Reviews pull requests using Lab45 AI API.
- Provides intelligent comments and suggestions for improving your code.
- Filters out files that match specified exclude patterns.
- Easy to set up and integrate into any GitHub workflow.

## Setup

To use the AI PR Reviewer automation please create a GitHub workflow in the repo using the sample below.

- Note that `LAB45_API_KEY` is org-level secret and is available in topcoder-platform organization so nothing secret is required on repo level.
- One could specify the LLM model used for AI Reviews when providing `LAB45_API_MODEL` to the `with` part of the workflow. By deault `gpt-4o` model will be used. See: https://github.com/topcoder-platform/tc-ai-pr-reviewer/blob/8d5db00e5927d9f870b904a6b80c12f6e4139a66/action.yml for details and Lab45 AI API for supported models: https://docs.lab45.ai/openapi_elements.html#/paths/v1.1-skills-skill_id--query/post

  - Currently supported are: `gpt-35-turbo-16k`, `gpt-4`, `gpt-4o`, `amazon.titan-tg1-large`, `gemini-pro`, `gemini-1.5-pro`, `gemini-1.5-flash`, `jais-30b-chat`

Sample GitHub workflow to create in TC repository:

```yml
name: AI PR Reviewer

on:
  pull_request:
    types:
      - opened
      - synchronize
permissions:
  pull-requests: write
jobs:
  tc-ai-pr-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: TC AI PR Reviewer
        uses: topcoder-platform/tc-ai-pr-reviewer@master
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} # The GITHUB_TOKEN is there by default so you just need to keep it like it is and not necessarily need to add it as secret as it will throw an error. [More Details](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#about-the-github_token-secret)
          LAB45_API_KEY: ${{ secrets.LAB45_API_KEY }}
          exclude: "**/*.json, **/*.md, **/*.jpg, **/*.png, **/*.jpeg, **/*.bmp, **/*.webp" # Optional: exclude patterns separated by commas
```

# How it works

This code implements a **GitHub Action** that performs automated code reviews on pull requests (PRs) using the **Lab45 AI API** for large language model (LLM) inference. The action is triggered when a pull request is created or updated(this is configurable by use case, if needed could skip branches or some PRs), and it analyzes the changes in the PR to provide actionable feedback on the code.

### Key Components

1. **Inputs and Configuration** :

- The action retrieves the following inputs using `@actions/core`:
  - [GITHUB_TOKEN](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html): Used to authenticate with the GitHub API.
  - [LAB45_API_KEY](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html): API key for authenticating with the Lab45 AI API.
  - [LAB45_API_MODEL](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html): Specifies the model to use for LLM inference.
- The [Octokit](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) library is used to interact with the GitHub API.

2. **Interfaces** :

- [PRDetails](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html): Represents metadata about the pull request (e.g., owner, repo, title, description).
- [Comment](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html): Represents a review comment to be posted on the PR.

3. **Main Workflow** :

- The [main()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function orchestrates the workflow:
  1. **Retrieve PR Details** : The [getPRDetails()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function extracts PR metadata from the GitHub event payload.
  2. **Fetch Diff** : Depending on the event type (`opened` or `synchronize`), the code fetches the diff of the PR using the GitHub API.
  3. **Filter Files** : Files matching exclusion patterns (provided via input) are filtered out using [minimatch](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html).
  4. **Analyze Code** : The [analyzeCodeAndComment()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function processes the diff, generates AI-based review comments, and posts them to the PR.

1. **AI-Powered Code Review** :

- The [analyzeCodeAndComment()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function:
  - Iterates over the parsed diff files and their chunks.
  - Creates a prompt for the AI model using [createPrompt()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html).
  - Sends the prompt to the Lab45 AI API via [getAIResponse()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html).
  - Converts the AI response into GitHub review comments using [createComment()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html).
  - Posts the comments to the PR using [createReviewComments()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html).

1. **Error Handling** :

- Errors during API calls or JSON parsing are logged to the console, ensuring the action does not fail silently.

---

### Prompting Technique

The **prompting technique** used in this implementation is designed to guide the AI model to generate structured and actionable feedback for code reviews. Key aspects of the prompt design include:

1. **Contextual Information** :

- The prompt includes the PR title and description to provide the AI with context about the purpose of the changes.

2. **Code Diff** :

- The diff of the file (including the chunk content and changes) is embedded in the prompt to focus the AI's attention on the modified lines.

3. **Instructions** :

- The prompt explicitly instructs the AI to:
  - Use a strict JSON format for responses: `{"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}`.
  - Avoid positive comments or compliments.
  - Only provide comments if there is something to improve.
  - Never suggest adding comments to the code.
  - Avoid commenting on removed lines or lines outside the diff range.

4. **GitHub Markdown** :

- The AI is instructed to format its comments in GitHub Markdown for compatibility with GitHub's review system.

---

### Implementation Details

1. **Prompt Creation** :

- The [createPrompt()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function dynamically generates a prompt for each file and chunk in the diff. It includes:
  - File name.
  - PR title and description.
  - The diff content formatted as a code block.

2. **AI Response Handling** :

- The [getAIResponse()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function sends the prompt to the Lab45 AI API and parses the JSON response. It uses the [extractJsonObject()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) helper to extract the JSON block from the AI's response.

3. **Posting Comments** :

- The [createReviewComments()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function uses the GitHub API to post the AI-generated comments as a review on the PR.

4. **Diff Parsing and Filtering** :

- The [parseDiff()](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) function from the [parse-diff](vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html) library is used to parse the diff into structured objects.
- Files are filtered based on exclusion patterns provided via input.

5. **Event Handling** :

- The action supports two events:
  - `opened`: Fetches the full diff of the PR.
  - `synchronize`: Fetches the diff between the previous and current commits.

---

### Summary

This GitHub Action leverages the Lab45 AI API to automate code reviews by analyzing pull request diffs and providing actionable feedback. The prompting technique ensures that the AI generates structured, relevant, and actionable comments while adhering to strict formatting and content guidelines. The implementation is robust, with error handling and support for multiple PR events, making it a powerful tool for improving code quality in collaborative development workflows at Topcoder platform.
