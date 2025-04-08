import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import axios from "axios";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const LAB45_API_KEY: string = core.getInput("LAB45_API_KEY");
const LAB45_API_MODEL: string = core.getInput("LAB45_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface Comment {
  body: string;
  path: string;
  // line: number;
  position: number;
}

async function getPRDetails(): Promise<PRDetails> {
  const eventFileData = readFileSync(
    process.env.GITHUB_EVENT_PATH || "",
    "utf8"
  );
  const { repository, number } = JSON.parse(eventFileData);
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<Comment>> {
  const comments: Array<Comment> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      console.log(`Analyzing code file.to ${file.to}...`);
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        console.log(`AI response for file.to ${file.to}:`, aiResponse);
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- IMPORTANT: Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  // see for details
  // https://docs.lab45.ai/openapi_elements.html#/paths/v1.1-skills-skill_id--query/post
  const skillParameters = {
    model_name: LAB45_API_MODEL,
    temperature: 0.2,
    max_output_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };
  const requestData = {
    messages: [{ role: "user", content: prompt }],
    skill_parameters: skillParameters,
    stream_response: false,
  };

  try {
    const { data } = await axios.request({
      method: "POST",
      maxBodyLength: Infinity,
      url: "https://api.lab45.ai/v1.1/skills/completion/query",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LAB45_API_KEY}`,
      },
      data: requestData,
    });

    const response = data.data.content.trim() || "{}";
    return extractJsonObject(response)?.reviews ?? null;
  } catch (error) {
    console.error("Error in getAIResponse:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<Comment> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      position: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<Comment>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

function extractJsonObject(content: string) {
  try {
    // Find the JSON block within the content
    const jsonStart = content.indexOf("```json\n") + 7; // Skip the '```json\n'
    const jsonEnd = content.lastIndexOf("```"); // Find the closing '```'

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error("JSON block not found in the content");
    }

    // Extract and parse the JSON string
    const jsonString = content.substring(jsonStart, jsonEnd).trim();
    return JSON.parse(jsonString);
  } catch (error: any) {
    console.error("Error extracting JSON object:", error.message);
    return null;
  }
}

async function main() {
  const prDetails = await getPRDetails();
  if (!prDetails) {
    console.log("No PR details found");
    return;
  }

  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
