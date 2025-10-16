import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import axios from "axios";

import { prompts } from "./prompts";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const LAB45_API_KEY: string = core.getInput("LAB45_API_KEY");
const LAB45_API_MODEL: string = core.getInput("LAB45_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

export interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  title: string;
  description: string;
}

export interface AiFilePayload {
  filename: string;
  status: string;
  patch: string | null;
  contents: string;
  additions: number;
  deletions: number;
}

interface Comment {
  body: string;
  path: string;
  line: number;
}

interface AIResponse {
  lineNumber: string;
  reviewComment: string;
  category: string,
  priority: string,
}

function addLineNumbers(contents: string) {
  return contents.split('\n').map((line, i) => `${i+1}: ${line}`).join('\n');
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
    head_sha: prResponse.data.head.sha,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getCommitDiff(owner: string, repo: string, baseRef: string, headRef: string): Promise<File[]> {
  const response = await octokit.repos.compareCommits({
    headers: {
      accept: "application/vnd.github.v3.diff",
    },
    owner,
    repo,
    base: baseRef,
    head: headRef,
  });

  return parseDiff((response.data as unknown as string) ?? '');
}

function chunkToDiffText(file: File) {
  return `${file.chunks.map(chunk => (
`${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}`
  )).join('\n...\n')}`;
}

function getFileDiff(filename: string, diff: File[]) {
  const file = diff.find(f => f.to === filename);
  if (!file) {
    return null;
  }

  return chunkToDiffText(file);
}

async function listAllFiles(owner: string, repo: string, pull_number: number) {
  // octokit.paginate handles pagination
  return octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100
  });
}

function isProbablyBinaryBuffer(buf: Buffer<ArrayBuffer>) {
  // Heuristic: if buffer contains NUL bytes, treat as binary
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function fetchFileContentAtRef(owner: string, repo: string, path: string, ref: string) {
  // Use the contents API to get the file contents at the given ref
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref
    });

    // If it's a file, res.data will have 'content' and 'encoding' (base64).
    // If it's a directory or something else, handle accordingly.
    if (Array.isArray(res.data)) {
      throw new Error(`Path ${path} is a directory at ref ${ref}`);
    }

    const { encoding, content } = (res.data as {encoding: string; content: string});
    if (!content) {
      // No content available
      return { text: null, isBinary: true };
    }

    if (encoding !== "base64") {
      // Unexpected encoding; try to decode conservatively
      const raw = Buffer.from(String(content), "utf8");
      const maybeBinary = isProbablyBinaryBuffer(raw);
      return {
        text: maybeBinary ? null : addLineNumbers(raw.toString("utf8")),
        isBinary: maybeBinary
      };
    }

    const buffer = Buffer.from(content, "base64");
    if (isProbablyBinaryBuffer(buffer)) {
      return { text: null, isBinary: true };
    }
    // Decode as utf8 string
    return { text: addLineNumbers(buffer.toString("utf8")), isBinary: false };
  } catch (err) {
    // Surface 404s and others to calling code
    throw err;
  }
}

async function analyzeCodeAndComment(
  payload: AiFilePayload,
  prDetails: PRDetails
): Promise<void> {
  console.log(`Analyzing contents of file.to ${payload.filename}`);
  const prompt = prompts.seniorDevReviewer(
    payload,
    prDetails,
  );
  const aiResponse = await getAIResponse(prompt);
  if (aiResponse) {
    console.log(`AI response for file.to ${payload.filename}:`, aiResponse);
    const newComments = createComment(payload.filename, aiResponse);
    if (newComments && newComments.length > 0) {
      try {
        await createReviewComments(
          prDetails.owner,
          prDetails.repo,
          prDetails.pull_number,
          newComments
        );
      } catch (error) {
        console.error(
          `Error creating review comment for file.to ${payload.filename}:`,
          error
        );
      }
    }
  }
}

async function getAIResponse(prompt: string): Promise<Array<AIResponse> | null> {
  console.log("Prompting AI for review...", prompt);
  // see for details
  // https://docs.waip.wiprocms.com/openapi_elements.html#/paths/v1.1-skills-skill_id--query/post
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
      url: "https://api.waip.wiprocms.com/v1.1/skills/completion/query",
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
  filename: string,
  aiResponses: Array<AIResponse>
): Array<Comment> {
  return aiResponses.flatMap((aiResponse) => {
    if (!filename) {
      return [];
    }
    return {
      body: `
[${{high: '❗❗', medium: '⚠️', low: '💡'}[aiResponse.priority] ?? aiResponse.priority} \`${aiResponse.category}\`]
${aiResponse.reviewComment}
`,
      path: filename,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComments(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<Comment>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    event: "COMMENT",
    comments,
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

  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  if (eventData.action !== "opened" && eventData.action !== "synchronize") {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  let allFiles;
  try {
    allFiles = await listAllFiles(prDetails.owner, prDetails.repo, prDetails.pull_number)

  } catch (err) {
    console.error("Failed to list PR files:", err);
    process.exit(2);
  }

  console.log(`Found ${allFiles.length} total changed file(s) in PR #${prDetails.pull_number}`);

  let syncFiles;
  if (eventData.action === 'synchronize') {
    syncFiles = await getCommitDiff(prDetails.owner, prDetails.repo, eventData.before, eventData.after)
  }

  for (const file of allFiles) {
    if (excludePatterns.some((pattern) =>
      minimatch(file.filename ?? "", pattern)
    )) {
      console.log(`Skipping [excluded] file ${file.filename}`);
      continue;
    }
    
    let patch = file.patch ?? null;
    
    if (eventData.action === 'synchronize') {
      patch = await getFileDiff(file.filename, syncFiles as File[]);
      if (patch === null) {
        continue;
      }
    } else {
      patch = chunkToDiffText(parseDiff(patch)[0])
    }
    
    const payload: AiFilePayload = {
      filename: file.filename,
      status: file.status,
      patch: patch,
      contents: '',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    };

    // Skip binary-like files: GitHub omits patch for many binary files.
    const isProbablyBinaryFromList = !patch;
    if (isProbablyBinaryFromList) {
      console.log(`Skipping ${file.filename} (likely binary or too large; no patch available). status=${file.status}`);
      // For removed files there is no content at head. We'll still send a payload that indicates removal with no contents.
      continue;
    }

    // For renamed files, file.previous_filename exists
    const effectivePath = file.filename;

    // If file was removed, we can't fetch contents at head;
    if (file.status === "removed") {
      // await sendToAIModel(payload);
      continue;
    }

    // For added or modified (or renamed -> new path): fetch contents at PR head
    let contentsText = '';
    try {
      const { text, isBinary } = await fetchFileContentAtRef(prDetails.owner, prDetails.repo, effectivePath, prDetails.head_sha);
      if (isBinary) {
        console.log(`Skipping ${file.filename} because content at head appears binary.`);
        continue;
      }
      contentsText = text ?? '';
    } catch (err: any) {
      // It's possible the file can't be fetched at head (moved/deleted). Log and include null contents.
      console.warn(`Warning: Could not fetch content for ${file.filename} at ref ${prDetails.head_sha}: ${err?.message ?? err}`);
      contentsText = '';
    }

    payload.contents = contentsText;

    // Send per-file payload (file-by-file)
    try {
      await analyzeCodeAndComment(payload, prDetails);
    } catch (err) {
      console.error(`Unexpected error while sending ${file.filename} to AI:`, err);
    }
  }

  console.log("Done processing PR files.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
