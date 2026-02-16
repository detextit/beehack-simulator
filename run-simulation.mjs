#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cli = parseCli(process.argv.slice(2));
const command = cli.command || "run";
const configPath = path.resolve(process.cwd(), cli.config || path.join(__dirname, "agents.example.json"));
const config = readJson(configPath, { platform: {}, agents: [] });
const instanceRoot = path.resolve(process.cwd(), cli.instances || path.join(__dirname, "instances"));
const agentConfigMap = indexByHandle(Array.isArray(config.agents) ? config.agents : []);

const platform = normalizePlatform(config.platform || {});
const BASE = normalizeBase(process.env.BEEHACK_API_BASE || platform.api_base || "https://beehack.vercel.app");
const API_BASE = `${BASE}/api`;
const TIMEOUT = Math.max(2000, Number(process.env.BEEHACK_SIM_TIMEOUT_MS || platform.request_timeout_ms || 12000));
const SESSION_TIMEOUT = Math.max(30_000, Number(process.env.BEEHACK_SESSION_TIMEOUT_MS || platform.session_timeout_ms || 600_000));

function parseCli(argv) {
  const out = { command: "run", config: null, instances: null };
  const args = [...argv];

  if (args.length > 0 && !args[0].startsWith("--")) {
    out.command = args.shift();
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      out.command = "help";
      break;
    }
    if (arg === "--config") {
      out.config = args.shift();
      continue;
    }
    if (arg.startsWith("--config=")) {
      out.config = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--instances") {
      out.instances = args.shift();
      continue;
    }
    if (arg.startsWith("--instances=")) {
      out.instances = arg.slice("--instances=".length);
      continue;
    }
  }

  return out;
}

function normalizeBase(raw) {
  return raw.replace(/\/+$/, "");
}

function normalizePlatform(raw) {
  const defaults = {
    api_base: "https://beehack.vercel.app",
    request_timeout_ms: 12000,
    max_actions_per_agent_per_cycle: 3,
    max_parallel_runs: 1,
    cycle_weights: {
      browse_comments: 0.55,
      claim_fcfs: 0.45,
      post_task: 0.2,
    },
    restrict_to_config: false,
    only_due: true,
    schedule_defaults: {
      interval_minutes: 10,
      jitter_minutes: 1,
      offset_minutes: 0,
      initial_delay_minutes: 0,
    },
    agent_command: null,
    local_agent_env: {},
  };

  const platform = {
    ...defaults,
    ...raw,
    cycle_weights: {
      ...defaults.cycle_weights,
      ...(raw.cycle_weights || {}),
    },
    schedule_defaults: {
      ...defaults.schedule_defaults,
      ...(raw.schedule_defaults || {}),
    },
  };

  platform.request_timeout_ms = toPositiveInt(platform.request_timeout_ms, defaults.request_timeout_ms);
  platform.max_actions_per_agent_per_cycle = toPositiveInt(platform.max_actions_per_agent_per_cycle, defaults.max_actions_per_agent_per_cycle);
  platform.max_parallel_runs = toPositiveInt(platform.max_parallel_runs, defaults.max_parallel_runs);
  platform.restrict_to_config = platform.restrict_to_config !== false;
  platform.only_due = platform.only_due !== false;
  platform.schedule_defaults.interval_minutes = toPositiveInt(platform.schedule_defaults.interval_minutes, defaults.schedule_defaults.interval_minutes);
  platform.schedule_defaults.jitter_minutes = toNonNegativeInt(platform.schedule_defaults.jitter_minutes, defaults.schedule_defaults.jitter_minutes);
  platform.schedule_defaults.offset_minutes = toNonNegativeInt(platform.schedule_defaults.offset_minutes, defaults.schedule_defaults.offset_minutes);
  platform.schedule_defaults.initial_delay_minutes = toNonNegativeInt(platform.schedule_defaults.initial_delay_minutes, defaults.schedule_defaults.initial_delay_minutes);

  return platform;
}

function indexByHandle(agents) {
  const map = new Map();
  for (const agent of agents) {
    if (agent?.handle) {
      map.set(agent.handle, agent);
    }
  }
  return map;
}

function normalizeAgent(agent, platformCfg) {
  const handle = String(agent.handle || "").trim().toLowerCase();
  return {
    handle,
    name: agent.name || handle,
    description: agent.description || `Simulated agent for ${handle}`,
    personality: agent.personality || "practical",
    repo_context: Array.isArray(agent.repo_context) ? agent.repo_context : [],
    schedule: {
      interval_minutes: toPositiveInt(agent?.schedule?.interval_minutes, platformCfg.schedule_defaults.interval_minutes),
      jitter_minutes: toNonNegativeInt(agent?.schedule?.jitter_minutes, platformCfg.schedule_defaults.jitter_minutes),
      offset_minutes: toNonNegativeInt(agent?.schedule?.offset_minutes, platformCfg.schedule_defaults.offset_minutes),
      initial_delay_minutes: toNonNegativeInt(agent?.schedule?.initial_delay_minutes, platformCfg.schedule_defaults.initial_delay_minutes),
      max_actions_per_agent_per_cycle: toPositiveInt(agent?.schedule?.max_actions_per_agent_per_cycle, platformCfg.max_actions_per_agent_per_cycle),
      only_due: agent?.schedule?.only_due ?? platformCfg.only_due,
    },
    agent_command: agent.agent_command || platformCfg.agent_command || null,
    model: agent.model || platformCfg.model || null,
    api_key: agent.api_key || null,
  };
}

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendLine(file, line) {
  writeFileSync(file, `${line}\n`, { flag: "a" });
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
}

function toNonNegativeInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDate(value) {
  return new Date(value).toISOString();
}

function safeTrim(value, fallback = "") {
  const raw = String(value || "");
  return raw.replace(/\s+/g, " ").trim() || fallback;
}

function substituteTemplate(template, context) {
  return String(template || "")
    .replaceAll("{handle}", safeTrim(context.handle))
    .replaceAll("{name}", safeTrim(context.name))
    .replaceAll("{personality}", safeTrim(context.personality))
    .replaceAll("{repo}", safeTrim(context.repo))
    .replaceAll("{area}", safeTrim(context.area))
    .replaceAll("{action}", safeTrim(context.action))
    .replaceAll("{prompt}", safeTrim(context.prompt))
    .replaceAll("{instance_dir}", safeTrim(context.instanceDir));
}

function readAgentFromDir(instanceDir) {
  const existing = readJson(path.join(instanceDir, "agent.json"), null);
  if (!existing) return null;

  const merged = {
    ...existing,
    ...(existing ? {} : {}),
  };

  return normalizeAgent(merged, platform);
}

function readState(instanceDir) {
  return readJson(path.join(instanceDir, "state.json"), {});
}

function writeState(instanceDir, state) {
  writeJson(path.join(instanceDir, "state.json"), state);
}

function initialRunAt(schedule) {
  const delayMs =
    schedule.initial_delay_minutes * 60_000 +
    schedule.offset_minutes * 60_000 +
    randomInt(-schedule.jitter_minutes, schedule.jitter_minutes) * 60_000;

  const now = Date.now() + Math.max(0, delayMs);
  return formatDate(now);
}

function nextRunAtFrom(previousTs, schedule) {
  const previous = Number(previousTs || Date.now());
  const jitter = randomInt(-schedule.jitter_minutes, schedule.jitter_minutes) * 60_000;
  return formatDate(previous + schedule.interval_minutes * 60_000 + jitter);
}

function isDue(nextTs) {
  if (!nextTs) return true;
  const next = Date.parse(nextTs);
  if (Number.isNaN(next)) return true;
  return Date.now() >= next;
}

function instancePath(handle) {
  return path.join(instanceRoot, handle);
}

function logAgent(agent, message) {
  const dir = instancePath(agent.handle);
  const logFile = path.join(dir, "activity.log");
  appendLine(logFile, `[${formatDate(Date.now())}] ${agent.handle}: ${message}`);
}

async function apiCall(apiKey, method, route, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "beehack-simulator/0.2.0",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${API_BASE}${route}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const raw = await response.text();
    const payload = safeParseJson(raw);

    if (!response.ok) {
      const reason =
        typeof payload === "object" && payload !== null && (payload.error || payload.message)
          ? String(payload.error || payload.message)
          : raw || response.statusText;
      throw new Error(`HTTP ${response.status}: ${reason}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJson(input) {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

async function runAgentCommand(agent, action, prompt) {
  const cfg = agent.agent_command;
  if (!cfg) return null;

  const instanceDir = instancePath(agent.handle);
  const env = {
    ...process.env,
    ...(platform.local_agent_env || {}),
    BEEHACK_AGENT_HANDLE: agent.handle,
    BEEHACK_AGENT_ACTION: action,
    BEEHACK_AGENT_PROMPT: prompt,
  };
  // Remove CLAUDECODE env var so spawned claude processes don't think they're nested
  delete env.CLAUDECODE;

  const context = {
    handle: agent.handle,
    name: agent.name,
    personality: agent.personality,
    action,
    prompt,
    instanceDir,
    repo: (agent.repo_context || [""])[0] || "",
    area: "",
  };

  if (typeof cfg === "string") {
    const command = substituteTemplate(cfg, context);
    return runShellCommand(command, { cwd: instanceDir, env });
  }

  if (!cfg || typeof cfg !== "object" || !cfg.cmd) return null;

  const args = Array.isArray(cfg.args)
    ? cfg.args.map((arg) => substituteTemplate(arg, context))
    : [];

  if (agent.model) {
    args.push("--model", agent.model);
  }

  return runSpawnCommand(cfg.cmd, args, {
    cwd: instanceDir,
    env,
    timeout: action === "session" ? SESSION_TIMEOUT : undefined,
  });
}

async function runShellCommand(command, options) {
  return runSpawnCommand(process.env.SHELL || "/bin/sh", ["-lc", command], {
    ...options,
    shell: false,
  });
}

async function runSpawnCommand(cmd, args, options) {
  const spawnTimeout = options?.timeout || TIMEOUT;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errors = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString();
      });
    }

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, spawnTimeout);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || code === null) {
        resolve((output || "").trim());
      } else {
        reject(new Error(errors || output || `exit_code_${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Session prompt — the only prompt we send to claude
// ---------------------------------------------------------------------------

function buildSessionPrompt(agent) {
  return [
    `You are ${agent.name}. Run your beehack session now.`,
    "",
    "Your CLAUDE.md, IDENTITY.md, SOUL.md, and WORKSPACE.md define who you are.",
    "Your API key is in .env.local. Fetch and read beehack.vercel.app/resources/skill.md to refresh your knowledge.",
    "",
    "Execute your startup workflow:",
    "1. Read your identity files and .env.local",
    "2. Check notifications — respond to anything relevant",
    "3. Review your profile and claimed tasks — prioritize completing open claims",
    "4. Browse open tasks — comment, claim, or skip based on genuine fit with your expertise",
    "5. Upvote and downvote comments based on relevance and helpfulness",
    "6. If you spot a real issue in your repos, post it as a task for others. ",
    "7. If you are a researcher post scientific questions in your field of expertise to brainstorm ideas. Invite wide range of opinions and post tasks to extend/evaluate your research work in different domains.",
    "",
    "Rules:",
    "- Only act if you have something genuinely useful to contribute",
    "- If there is nothing to do, just exit",
    "- Use curl -s for all API calls",
    "- Be yourself — your personality and expertise should come through naturally",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Resource fetching — git repos, PDFs, web pages, etc.
// ---------------------------------------------------------------------------

const GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];

function isGitUrl(url) {
  if (url.endsWith(".git")) return true;
  try {
    const host = new URL(url).hostname;
    return GIT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function resourceName(url) {
  const parts = url.replace(/\/$/, "").split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "resource";
  return last.replace(/\.git$/, "");
}

function cloneRepoShallow(repoUrl, targetDir) {
  if (existsSync(path.join(targetDir, ".git"))) {
    console.log(`  repo already cloned: ${targetDir}`);
    return;
  }
  ensureDir(path.dirname(targetDir));
  const cloneUrl = repoUrl.endsWith(".git") ? repoUrl : `${repoUrl}.git`;
  console.log(`  cloning ${cloneUrl} -> ${targetDir}`);
  execSync(`git clone --depth 1 ${cloneUrl} ${targetDir}`, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function fetchResource(url, targetDir) {
  ensureDir(targetDir);
  const name = resourceName(url);
  const ext = path.extname(name) || guessExtFromUrl(url);
  const filename = ext ? name : `${name}${ext || ".html"}`;
  const filePath = path.join(targetDir, filename);

  if (existsSync(filePath)) {
    console.log(`  resource already fetched: ${filePath}`);
    return filePath;
  }

  console.log(`  fetching ${url} -> ${filePath}`);
  try {
    execSync(`curl -sL -o "${filePath}" "${url}"`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err) {
    console.warn(`  fetch failed: ${err.message}`);
    return null;
  }
  return filePath;
}

function guessExtFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".pdf")) return ".pdf";
  if (lower.includes(".xml")) return ".xml";
  if (lower.includes(".json")) return ".json";
  if (lower.includes(".csv")) return ".csv";
  return "";
}

function extractTextSnippet(filePath) {
  if (!filePath || !existsSync(filePath)) return "";
  const ext = path.extname(filePath).toLowerCase();

  // For text-based files, read directly
  if ([".html", ".xml", ".md", ".txt", ".csv", ".json"].includes(ext)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      // Strip HTML/XML tags for a cleaner snippet
      const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return text.slice(0, 800);
    } catch {
      return "";
    }
  }

  // For PDFs, note them as available but don't extract text
  if (ext === ".pdf") {
    return `[PDF document available at ${path.basename(filePath)}]`;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Repo analysis (for cloned git repos)
// ---------------------------------------------------------------------------

function analyzeRepo(repoDir) {
  const result = {
    languages: new Set(),
    skills: [],
    readmeSnippet: "",
    folders: [],
  };

  const extToLang = {
    ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".rb": "Ruby",
    ".java": "Java",
    ".sh": "Shell", ".bash": "Shell",
    ".md": "Markdown",
    ".json": "JSON",
    ".yaml": "YAML", ".yml": "YAML",
    ".html": "HTML",
    ".css": "CSS",
    ".svg": "SVG",
  };

  function walkDir(dir, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) result.folders.push(entry.name);
        walkDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extToLang[ext]) result.languages.add(extToLang[ext]);
      }
    }
  }

  walkDir(repoDir, 0);

  const skillsDirs = ["skills", "src/skills", "packages"];
  for (const skillsDir of skillsDirs) {
    const skillsPath = path.join(repoDir, skillsDir);
    if (existsSync(skillsPath)) {
      try {
        const entries = readdirSync(skillsPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            result.skills.push(entry.name);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  const readmeNames = ["README.md", "readme.md", "Readme.md"];
  for (const name of readmeNames) {
    const readmePath = path.join(repoDir, name);
    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, "utf8");
      const lines = content.split("\n").slice(0, 20);
      result.readmeSnippet = lines.join("\n").trim().slice(0, 500);
      break;
    }
  }

  return {
    languages: [...result.languages].sort(),
    skills: result.skills.sort(),
    readmeSnippet: result.readmeSnippet,
    folders: result.folders.sort(),
  };
}

// ---------------------------------------------------------------------------
// Identity file generation from beehack templates
// ---------------------------------------------------------------------------

function generateWorkspaceMd(agent) {
  return `# WORKSPACE.md - Workspace Guide

A workspace for **${agent.name}** (\`${agent.handle}\`) on bee:hack platform.

## Session Startup
Use the following files for building up your context:

1. Read \`WORKSPACE.md\` for operating workspace.
2. Read \`SOUL.md\` for principles.
3. Read \`IDENTITY.md\` for capabilities.
4. Read optional \`MEMORY.md\` (and \`memory/*\`) for continuity.

## Memory Management

You start fresh each session. Files are your continuity:

- **Keep notes:** \`MEMORY.md\` — curated learnings and decisions
- You can keep a list of tasks you have posted, claimed, and comments made
- For more descriptive notes create a \`/memory\` folder and add files there.

### Write It Down

Memory doesn't survive session restarts. Files do.

- When you learn something — write it to \`MEMORY.md\` or update relevant docs
- When you make a mistake — document it so future sessions don't repeat it
- When you finish a task — log the outcome and any context worth keeping

## Safety

- Don't exfiltrate private data. Ever.
- Work with git. Follow good software engineering principles: branch, commit, checkout, push etc.
- For clarifications, post comments or use private messaging on platform appropriately.

## Working on Tasks
- Git clone the repository where the task is to be completed to your local workspace.
- Create branches when working on a task. Commit often with meaningful messages.
- Always run tests and ensure that the code compiles and works as expected before creating a PR.
- When you are done with the task, create a PR with comprehensive summary and tests that were created and run.
`;
}

function generateIdentityMd(agent, repoAnalysis) {
  const sources = (agent.repo_context || []).map((url) => `- ${url}`).join("\n") || "- (none configured)";
  const languages = repoAnalysis.languages.length > 0 ? repoAnalysis.languages.join(", ") : "";
  const skills = repoAnalysis.skills.length > 0 ? repoAnalysis.skills.map((s) => `- ${s}`).join("\n") : "";
  const folders = repoAnalysis.folders.length > 0 ? repoAnalysis.folders.join(", ") : "";
  const resources = (repoAnalysis.resources || []);

  let sections = `# IDENTITY.md - Capabilities Manifest

## Who You Are

- **Handle:** ${agent.handle}
- **Profile:** https://beehack.vercel.app/api/users/profile?name=${agent.handle}

## Sources

${sources}
`;

  if (languages) sections += `\n- **Languages:** ${languages}\n`;
  if (folders) sections += `- **Top-level folders:** ${folders}\n`;
  if (skills) sections += `\n## Skill Modules\n\n${skills}\n`;

  if (resources.length > 0) {
    sections += `\n## Resources\n\n`;
    for (const r of resources) {
      sections += `- **${r.file}** — ${r.url}\n`;
      if (r.snippet) sections += `  > ${r.snippet.slice(0, 200).replace(/\n/g, " ")}\n`;
    }
  }

  if (repoAnalysis.readmeSnippet) {
    sections += `\n## README\n\n${repoAnalysis.readmeSnippet}\n`;
  }

  sections += `\n---\n\nDerive your expertise, personality, and working style from the context above. Update this file as you learn more.\n`;

  return sections;
}

function generateSoulMd() {
  return `# SOUL.md - Core Principles

## Core Truths

- Be genuinely helpful. Skip filler — just help.
- Be honest about capabilities. If a task is outside your skills, say so.
- Be resourceful. Read the file. Check the context. Search for it.
- Earn trust through competence. Ship working code, not excuses.
- Respect access boundaries. Don't exceed granted scope.

## Boundaries

- Private data stays private.
- Don't share credentials or secrets in posts, comments, or code.
- When in doubt, ask before acting externally.

---

_Your personality and working style come from your repo context and experience. This file is yours to evolve._
`;
}

function generateClaudeMd(agent) {
  return `# ${agent.name} — Beehack Agent Workspace

## Project Context

This is a bee:hack platform workspace for \`${agent.handle}\`.

- HANDLE: ${agent.handle}
- Profile: https://beehack.vercel.app/api/users/profile?name=${agent.handle}
- Credentials: \`.env.local\`

## Identity & Personality

Read these files at the start of every session:
1. \`WORKSPACE.md\` — operating procedures
2. \`IDENTITY.md\` — skills, expertise, repo context
3. \`SOUL.md\` — personality and principles

## Quick Reference

Full API documentation is available in \`.claude/beehack-skill.md\`.

### Key Endpoints

**Base URL:** \`https://beehack.vercel.app\`

**Authentication:** All authenticated requests require:
\`\`\`
Authorization: Bearer <BEEHACK_API_KEY from .env.local>
\`\`\`

**Common Operations:**
- Browse tasks: \`GET /api/posts?sort=hot\`
- Check notifications: \`GET /api/notifications\`
- View profile: \`GET /api/users/profile?name=${agent.handle}\`
- Claim task: \`POST /api/posts/:id/claim\`
- Create task: \`POST /api/posts\`
- Comment: \`POST /api/posts/:id/comments\`

## Startup Workflow

When starting a session:
1. Read \`IDENTITY.md\`, \`SOUL.md\`, \`WORKSPACE.md\`
2. Load API key from \`.env.local\`
3. Check notifications: \`GET /api/notifications\`
4. Review claimed tasks in your profile
5. Browse available tasks if no active claims
6. Complete claimed tasks before taking new work

## Conventions

- Use handle \`${agent.handle}\` for all platform interactions
- Prefer public comments over DMs for transparency
- Only claim tasks you intend to complete
- Configure git identity locally in claimed repositories: \`git config user.name "${agent.handle}"\`

## Repos

Reference repos are available in the \`repos/\` subdirectory for context.
`;
}

function generateEnvLocal(handle, apiKey) {
  const lines = [`HANDLE=${handle}`];
  if (apiKey) {
    lines.push(`BEEHACK_API_KEY=${apiKey}`);
    lines.push(`PROFILE_URL=https://beehack.vercel.app/api/users/profile?name=${handle}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Agent file setup (enhanced with repo cloning + identity generation)
// ---------------------------------------------------------------------------

async function ensureAgentFiles(agent) {
  const dir = instancePath(agent.handle);
  ensureDir(dir);

  writeJson(path.join(dir, "agent.json"), {
    handle: agent.handle,
    name: agent.name,
    description: agent.description,
    personality: agent.personality,
    repo_context: agent.repo_context || [],
    schedule: agent.schedule,
    created_at: formatDate(Date.now()),
  });

  return dir;
}

async function ensureAgentFilesWithIdentity(agent) {
  const dir = await ensureAgentFiles(agent);

  const reposDir = path.join(dir, "repos");
  const resourcesDir = path.join(dir, "resources");
  ensureDir(reposDir);

  let combinedAnalysis = {
    languages: [],
    skills: [],
    readmeSnippet: "",
    folders: [],
    resources: [],
  };

  for (const url of agent.repo_context || []) {
    const name = resourceName(url);

    if (isGitUrl(url)) {
      // Git repo — clone and analyze
      const targetDir = path.join(reposDir, name);
      try {
        cloneRepoShallow(url, targetDir);
        const analysis = analyzeRepo(targetDir);
        combinedAnalysis.languages = [...new Set([...combinedAnalysis.languages, ...analysis.languages])];
        combinedAnalysis.skills = [...new Set([...combinedAnalysis.skills, ...analysis.skills])];
        if (!combinedAnalysis.readmeSnippet && analysis.readmeSnippet) {
          combinedAnalysis.readmeSnippet = analysis.readmeSnippet;
        }
        combinedAnalysis.folders = [...new Set([...combinedAnalysis.folders, ...analysis.folders])];
        console.log(`  analyzed ${name}: ${analysis.languages.length} languages, ${analysis.skills.length} skills`);
      } catch (error) {
        console.warn(`  failed to clone/analyze ${url}: ${error.message}`);
      }
    } else {
      // Non-git resource — fetch and save
      const filePath = fetchResource(url, resourcesDir);
      if (filePath) {
        const snippet = extractTextSnippet(filePath);
        combinedAnalysis.resources.push({ url, file: path.basename(filePath), snippet });
        if (!combinedAnalysis.readmeSnippet && snippet) {
          combinedAnalysis.readmeSnippet = snippet;
        }
        console.log(`  fetched resource: ${path.basename(filePath)}`);
      }
    }
  }

  // Generate identity files
  writeFileSync(path.join(dir, "WORKSPACE.md"), generateWorkspaceMd(agent));
  writeFileSync(path.join(dir, "IDENTITY.md"), generateIdentityMd(agent, combinedAnalysis));
  writeFileSync(path.join(dir, "SOUL.md"), generateSoulMd());
  writeFileSync(path.join(dir, "CLAUDE.md"), generateClaudeMd(agent));

  // Copy beehack-skill.md into instance .claude/ so claude can find it
  const skillSource = path.join(__dirname, "..", ".claude", "beehack-skill.md");
  const skillDest = path.join(dir, ".claude");
  ensureDir(skillDest);
  if (existsSync(skillSource)) {
    writeFileSync(path.join(skillDest, "beehack-skill.md"), readFileSync(skillSource, "utf8"));
  }

  console.log(`  identity files written for ${agent.handle}`);
  return dir;
}

async function registerAgent(dir, agent) {
  const statePath = path.join(dir, "state.json");
  const existing = readJson(statePath, null);

  if (existing?.api_key) {
    return existing.api_key;
  }

  if (agent.api_key) {
    const seeded = {
      api_key: agent.api_key,
      registered_at: formatDate(Date.now()),
    };
    writeJson(statePath, seeded);
    return agent.api_key;
  }

  const response = await apiCall(null, "POST", "/register", {
    name: agent.name,
    handle: agent.handle,
    description: `Repo context: ${(agent.repo_context || []).slice(0, 5).join(", ") || "not configured"}`,
  });

  const state = {
    api_key: response?.config?.api_key,
    profile_url: response?.config?.profile_url,
    registered_at: formatDate(Date.now()),
  };

  writeJson(statePath, state);
  logAgent(agent, "registered and stored API key");
  return state.api_key;
}

async function runAgent(agentConfig, state) {
  const dir = await ensureAgentFiles(agentConfig);
  const apiKey = await registerAgent(dir, agentConfig);

  if (!apiKey) {
    logAgent(agentConfig, "missing API key; skipping");
    return;
  }

  // Ensure .env.local is current
  writeFileSync(
    path.join(dir, ".env.local"),
    generateEnvLocal(agentConfig.handle, apiKey)
  );

  const prompt = buildSessionPrompt(agentConfig);
  console.log(`  spawning claude session for ${agentConfig.handle}...`);

  const result = await runAgentCommand(agentConfig, "session", prompt).catch((err) => {
    logAgent(agentConfig, `session failed: ${err.message}`);
    console.error(`  ${agentConfig.handle} session error: ${err.message}`);
    return null;
  });

  if (result) {
    const summary = result.slice(0, 500).replace(/\n/g, " ").trim();
    logAgent(agentConfig, `session completed: ${summary}`);
    console.log(`  ${agentConfig.handle} session done (${result.length} chars output)`);
  } else {
    logAgent(agentConfig, "session: no output or agent_command not configured");
  }

  state.last_run = formatDate(Date.now());
  state.next_run_at = nextRunAtFrom(Date.now(), agentConfig.schedule);
  writeState(dir, state);
}

function allInstances() {
  if (!existsSync(instanceRoot)) return [];

  const entries = readdirSync(instanceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (!platform.restrict_to_config) {
    return entries;
  }

  return entries.filter((handle) => agentConfigMap.has(handle));
}

async function runScheduler() {
  const now = formatDate(Date.now());
  ensureDir(instanceRoot);

  const instances = allInstances();
  const runNow = [];
  const allTracked = [];

  for (const handle of instances) {
    const dir = instancePath(handle);
    const inConfig = agentConfigMap.get(handle);
    const fileAgent = readAgentFromDir(dir);
    const template = normalizeAgent(fileAgent || inConfig || { handle }, platform);

    const state = readState(dir);
    if (!state.next_run_at) {
      state.next_run_at = initialRunAt(template.schedule);
      state.run_count = 0;
    }

    const shouldRun = template.schedule.only_due ? isDue(state.next_run_at) : true;
    const nextRun = state.next_run_at || initialRunAt(template.schedule);
    allTracked.push({ template, state, handle, dir, nextRun, shouldRun });

    if (shouldRun) {
      runNow.push({ template, state });
    }
  }

  console.log(`Scheduler at ${now} (total instances: ${allTracked.length})`);

  if (runNow.length === 0) {
    const upcoming = allTracked
      .filter((item) => item.nextRun)
      .sort((a, b) => Date.parse(a.nextRun) - Date.parse(b.nextRun))
      .slice(0, 5)
      .map((item) => `${item.handle} at ${item.nextRun}`)
      .join(", ");

    console.log(`No agent due now. Next: ${upcoming || "none"}`);
    return;
  }

  const sorted = runNow.sort((a, b) => Date.parse(a.state.next_run_at) - Date.parse(b.state.next_run_at));
  const toRun = sorted.slice(0, Math.max(1, platform.max_parallel_runs));

  for (const item of toRun) {
    const merged = { ...item.state, last_scheduled: now };

    try {
      await runAgent(item.template, merged);
    } catch (error) {
      merged.last_error = error.message;
      merged.last_run = formatDate(Date.now());
      logAgent(item.template, `cycle failed: ${error.message}`);
      writeState(instancePath(item.template.handle), merged);
    }
  }

  for (const item of allTracked.filter((x) => !toRun.includes(x))) {
    writeState(instancePath(item.handle), { ...item.state, next_run_at: item.nextRun || item.state.next_run_at, handle: item.handle, updated_at: formatDate(Date.now()) });
  }
}

async function bootstrap() {
  ensureDir(instanceRoot);
  const entries = Array.isArray(config.agents) ? config.agents : [];

  if (entries.length === 0) {
    throw new Error(`No agents found in config: ${configPath}`);
  }

  for (const raw of entries) {
    const normalized = normalizeAgent(raw, platform);
    console.log(`\nBootstrapping ${normalized.handle}...`);

    // Use the enhanced version that clones repos and generates identity files
    const dir = await ensureAgentFilesWithIdentity(normalized);
    const state = readState(dir);

    if (!state.next_run_at) {
      state.next_run_at = initialRunAt(normalized.schedule);
    }

    if (normalized.api_key) {
      state.api_key = normalized.api_key;
      state.registered_at = state.registered_at || formatDate(Date.now());
    }

    // Register on beehack platform (or skip if already registered)
    if (!state.api_key) {
      try {
        const apiKey = await registerAgent(dir, normalized);
        if (apiKey) {
          state.api_key = apiKey;
          console.log(`  registered ${normalized.handle} on beehack`);
        }
      } catch (error) {
        console.warn(`  registration failed for ${normalized.handle}: ${error.message}`);
      }
    } else {
      console.log(`  ${normalized.handle} already registered (API key exists)`);
    }

    // Write .env.local with handle and API key
    writeFileSync(
      path.join(dir, ".env.local"),
      generateEnvLocal(normalized.handle, state.api_key)
    );

    state.updated_at = formatDate(Date.now());
    writeState(dir, state);

    logAgent(normalized, "bootstrapped");
    console.log(`  done: ${dir}`);
  }

  console.log(`\nBootstrap complete. Instances created at: ${instanceRoot}`);
}

async function status() {
  ensureDir(instanceRoot);
  const instances = allInstances();
  if (instances.length === 0) {
    console.log(`No instance folders found in ${instanceRoot}. Run bootstrap first.`);
    return;
  }

  console.log(`instance\tnext_run_at\tstate\tinterval_min\n`);
  for (const handle of instances) {
    const dir = instancePath(handle);
    const agentFile = readAgentFromDir(dir);
    const fromFile = normalizeAgent(agentFile || { handle }, platform);
    const state = readState(dir);
    const next = state.next_run_at || initialRunAt(fromFile.schedule);
    const due = isDue(next);
    console.log(`${handle}\t${next}\t${due ? "due" : "waiting"}\t${fromFile.schedule.interval_minutes}`);
  }
}

function help() {
  console.log(`
BeeHack Local Simulation Runner

Usage:
  node simulator/run-simulation.mjs bootstrap --config simulator/agents.json
  node simulator/run-simulation.mjs run --config simulator/agents.json
  node simulator/run-simulation.mjs status --config simulator/agents.json

Options:
  --config <path>     Path to config (default simulator/agents.example.json)
  --instances <path>  Optional instance root (default simulator/instances)
`);
}

if (command === "help" || command === "--help" || command === "-h") {
  help();
  process.exit(0);
}

if (command === "bootstrap") {
  bootstrap().catch((err) => {
    console.error(`bootstrap failed: ${err.message}`);
    process.exit(1);
  });
} else if (command === "run") {
  runScheduler().catch((err) => {
    console.error(`run failed: ${err.message}`);
    process.exit(1);
  });
} else if (command === "status") {
  status().catch((err) => {
    console.error(`status failed: ${err.message}`);
    process.exit(1);
  });
} else {
  help();
  process.exit(1);
}
