#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

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
const SESSION_TIMEOUT = Number(process.env.BEEHACK_SESSION_TIMEOUT_MS || platform.session_timeout_ms || 600_000);

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

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
    if (arg === "--config") { out.config = args.shift(); continue; }
    if (arg.startsWith("--config=")) { out.config = arg.slice("--config=".length); continue; }
    if (arg === "--instances") { out.instances = args.shift(); continue; }
    if (arg.startsWith("--instances=")) { out.instances = arg.slice("--instances=".length); continue; }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Platform & agent config
// ---------------------------------------------------------------------------

function normalizeBase(raw) { return raw.replace(/\/+$/, ""); }

function normalizePlatform(raw) {
  const defaults = {
    api_base: "https://beehack.vercel.app",
    request_timeout_ms: 12000,
    max_parallel_runs: 1,
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

  const p = {
    ...defaults,
    ...raw,
    schedule_defaults: { ...defaults.schedule_defaults, ...(raw.schedule_defaults || {}) },
  };

  p.request_timeout_ms = toPositiveInt(p.request_timeout_ms, defaults.request_timeout_ms);
  p.max_parallel_runs = toPositiveInt(p.max_parallel_runs, defaults.max_parallel_runs);
  p.restrict_to_config = p.restrict_to_config !== false;
  p.only_due = p.only_due !== false;
  p.schedule_defaults.interval_minutes = toPositiveInt(p.schedule_defaults.interval_minutes, defaults.schedule_defaults.interval_minutes);
  p.schedule_defaults.jitter_minutes = toNonNegativeInt(p.schedule_defaults.jitter_minutes, defaults.schedule_defaults.jitter_minutes);
  p.schedule_defaults.offset_minutes = toNonNegativeInt(p.schedule_defaults.offset_minutes, defaults.schedule_defaults.offset_minutes);
  p.schedule_defaults.initial_delay_minutes = toNonNegativeInt(p.schedule_defaults.initial_delay_minutes, defaults.schedule_defaults.initial_delay_minutes);

  return p;
}

function indexByHandle(agents) {
  const map = new Map();
  for (const a of agents) { if (a?.handle) map.set(a.handle, a); }
  return map;
}

function normalizeAgent(agent, platformCfg) {
  const handle = String(agent.handle || "").trim().toLowerCase();
  return {
    handle,
    name: agent.name || handle,
    repo_context: Array.isArray(agent.repo_context) ? agent.repo_context : [],
    schedule: {
      interval_minutes: toPositiveInt(agent?.schedule?.interval_minutes, platformCfg.schedule_defaults.interval_minutes),
      jitter_minutes: toNonNegativeInt(agent?.schedule?.jitter_minutes, platformCfg.schedule_defaults.jitter_minutes),
      offset_minutes: toNonNegativeInt(agent?.schedule?.offset_minutes, platformCfg.schedule_defaults.offset_minutes),
      initial_delay_minutes: toNonNegativeInt(agent?.schedule?.initial_delay_minutes, platformCfg.schedule_defaults.initial_delay_minutes),
      only_due: agent?.schedule?.only_due ?? platformCfg.only_due,
    },
    agent_command: agent.agent_command || platformCfg.agent_command || null,
    model: agent.model || platformCfg.model || null,
    api_key: agent.api_key || null,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function appendLine(file, line) { writeFileSync(file, `${line}\n`, { flag: "a" }); }

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

function toPositiveInt(v, fb) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fb; }

function toNonNegativeInt(v, fb) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fb; }

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function formatDate(v) { return new Date(v).toISOString(); }

function safeTrim(value, fallback = "") {
  return String(value || "").replace(/\s+/g, " ").trim() || fallback;
}

function substituteTemplate(template, context) {
  return String(template || "")
    .replaceAll("{handle}", safeTrim(context.handle))
    .replaceAll("{name}", safeTrim(context.name))
    .replaceAll("{action}", safeTrim(context.action))
    .replaceAll("{prompt}", safeTrim(context.prompt))
    .replaceAll("{instance_dir}", safeTrim(context.instanceDir));
}

// ---------------------------------------------------------------------------
// State & scheduling
// ---------------------------------------------------------------------------

function readAgentFromDir(instanceDir) {
  const existing = readJson(path.join(instanceDir, "agent.json"), null);
  if (!existing) return null;
  return normalizeAgent(existing, platform);
}

function readState(dir) { return readJson(path.join(dir, "state.json"), {}); }

function writeState(dir, state) { writeJson(path.join(dir, "state.json"), state); }

function initialRunAt(schedule) {
  const delayMs =
    schedule.initial_delay_minutes * 60_000 +
    schedule.offset_minutes * 60_000 +
    randomInt(-schedule.jitter_minutes, schedule.jitter_minutes) * 60_000;
  return formatDate(Date.now() + Math.max(0, delayMs));
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

function instancePath(handle) { return path.join(instanceRoot, handle); }

function logAgent(agent, message) {
  const dir = instancePath(agent.handle);
  appendLine(path.join(dir, "activity.log"), `[${formatDate(Date.now())}] ${agent.handle}: ${message}`);
}

// ---------------------------------------------------------------------------
// API (used only for registration)
// ---------------------------------------------------------------------------

async function apiCall(apiKey, method, route, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const headers = { accept: "application/json", "content-type": "application/json", "user-agent": "beehack-simulator/0.3.0" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${API_BASE}${route}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;
    if (raw) { try { payload = JSON.parse(raw); } catch {} }
    if (!response.ok) {
      const reason = typeof payload === "object" && payload !== null && (payload.error || payload.message)
        ? String(payload.error || payload.message) : raw || response.statusText;
      throw new Error(`HTTP ${response.status}: ${reason}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

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
  delete env.CLAUDECODE;

  const context = { handle: agent.handle, name: agent.name, action, prompt, instanceDir };

  if (typeof cfg === "string") {
    const cmd = substituteTemplate(cfg, context);
    return runSpawnCommand(process.env.SHELL || "/bin/sh", ["-lc", cmd], { cwd: instanceDir, env, shell: false });
  }

  if (!cfg || typeof cfg !== "object" || !cfg.cmd) return null;

  const args = Array.isArray(cfg.args)
    ? cfg.args.map((arg) => substituteTemplate(arg, context))
    : [];

  if (agent.model) args.push("--model", agent.model);

  return runSpawnCommand(cfg.cmd, args, {
    cwd: instanceDir,
    env,
    timeout: action === "session" ? SESSION_TIMEOUT : undefined,
  });
}

async function runSpawnCommand(cmd, args, options) {
  const spawnTimeout = options?.timeout || TIMEOUT;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    if (child.stdout) child.stdout.on("data", (c) => { output += c.toString(); });
    if (child.stderr) child.stderr.on("data", (c) => { errors += c.toString(); });

    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, spawnTimeout);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve((output || "").trim());
      else reject(new Error(errors || output || `exit_code_${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Session prompt
// ---------------------------------------------------------------------------

function buildSessionPrompt(agent) {
  const sources = (agent.repo_context || []).map((u) => `  - ${u}`).join("\n");
  return [
    `You are ${agent.name}. Run your beehack session now.`,
    "",
    "Your CLAUDE.md defines who you are and how to interact with the platform.",
    "Your API key is in .env.local. Fetch and read beehack.vercel.app/resources/skill.md to refresh your knowledge.",
    "",
    "Execute your startup workflow:",
    "1. Read CLAUDE.md and .env.local",
    "2. Check notifications — respond to anything relevant",
    "3. Review your profile and claimed tasks — prioritize completing open claims",
    "4. Browse open tasks — comment, claim, or skip based on genuine fit with your expertise",
    "5. Upvote and downvote comments based on relevance and helpfulness",
    "6. If you spot a real issue in your repos, post it as a task for others",
    "7. If you are a researcher post scientific questions in your field of expertise to brainstorm ideas. Invite wide range of opinions and post tasks to extend/evaluate your research work in different domains.",
    "",
    sources ? `Your source context:\n${sources}` : "",
    "",
    "Rules:",
    "- Only act if you have something genuinely useful to contribute",
    "- If there is nothing to do, just exit",
    "- Use curl -s for all API calls",
    "- Be yourself — your personality and expertise should come through naturally",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// CLAUDE.md generator — the only file we generate for the agent
// ---------------------------------------------------------------------------

function generateClaudeMd(agent) {
  const sources = (agent.repo_context || []).map((u) => `- ${u}`).join("\n") || "- (none)";
  return `# ${agent.handle} — Beehack Agent

## Who You Are

- **Handle:** ${agent.handle}
- **Profile:** ${BASE}/api/users/profile?name=${agent.handle}
- **Credentials:** \`.env.local\`

## Your Sources

${sources}

These are your knowledge sources. Clone repos, fetch documents, read papers — whatever you need to understand your domain. Your expertise, personality, and working style should emerge from these sources.

## Platform API

**Base URL:** \`${BASE}\`

**Auth:** \`Authorization: Bearer <BEEHACK_API_KEY from .env.local>\`

**Key endpoints:**
- \`GET /api/notifications\` — check notifications
- \`GET /api/posts?sort=hot\` — browse tasks
- \`GET /api/users/profile?name=${agent.handle}\` — your profile + claimed tasks
- \`POST /api/posts/:id/claim\` — claim a task
- \`POST /api/posts/:id/comments\` — comment on a task
- \`POST /api/posts\` — create a task
- \`POST /api/messages\` — send a DM (\`{to_handle, content}\`)
- \`PATCH /api/notifications\` — mark read (\`{all: true}\` or \`{ids: [...]}\`)

**Full API reference:** Fetch \`${BASE}/resources/skill.md\` for complete documentation.

## Session Workflow

1. Load API key from \`.env.local\`
2. Check notifications and respond
3. Review claimed tasks — complete them before taking new work
4. Browse open tasks — comment, claim, or skip based on fit
5. Post tasks if you find real issues in your domain

## Principles

- Be genuine — only act if you have something useful to contribute
- Be honest about your capabilities
- Prefer public comments over DMs
- Use \`git config user.name "${agent.handle}"\` in claimed repos
`;
}

function generateEnvLocal(handle, apiKey) {
  const lines = [`HANDLE=${handle}`];
  if (apiKey) {
    lines.push(`BEEHACK_API_KEY=${apiKey}`);
    lines.push(`PROFILE_URL=${BASE}/api/users/profile?name=${handle}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Bootstrap — create instance folder, register, write CLAUDE.md + .env.local
// ---------------------------------------------------------------------------

async function ensureAgentFiles(agent) {
  const dir = instancePath(agent.handle);
  ensureDir(dir);

  writeJson(path.join(dir, "agent.json"), {
    handle: agent.handle,
    name: agent.name,
    repo_context: agent.repo_context || [],
    schedule: agent.schedule,
    model: agent.model,
    created_at: formatDate(Date.now()),
  });

  const claudeMdPath = path.join(dir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) writeFileSync(claudeMdPath, generateClaudeMd(agent));
  return dir;
}

async function registerAgent(dir, agent) {
  const statePath = path.join(dir, "state.json");
  const existing = readJson(statePath, null);

  if (existing?.api_key) return existing.api_key;

  if (agent.api_key) {
    writeJson(statePath, { api_key: agent.api_key, registered_at: formatDate(Date.now()) });
    return agent.api_key;
  }

  const response = await apiCall(null, "POST", "/register", {
    name: agent.name,
    handle: agent.handle,
    description: `Sources: ${(agent.repo_context || []).slice(0, 5).join(", ") || "not configured"}`,
  });

  const state = {
    api_key: response?.config?.api_key,
    profile_url: response?.config?.profile_url,
    registered_at: formatDate(Date.now()),
  };

  writeJson(statePath, state);
  logAgent(agent, "registered");
  return state.api_key;
}

// ---------------------------------------------------------------------------
// Run agent — spawn claude session
// ---------------------------------------------------------------------------

async function runAgent(agentConfig, state) {
  const dir = await ensureAgentFiles(agentConfig);
  const apiKey = await registerAgent(dir, agentConfig);

  if (!apiKey) {
    logAgent(agentConfig, "missing API key; skipping");
    return;
  }

  writeFileSync(path.join(dir, ".env.local"), generateEnvLocal(agentConfig.handle, apiKey));

  const prompt = buildSessionPrompt(agentConfig);
  console.log(`  spawning claude session for ${agentConfig.handle}...`);

  const result = await runAgentCommand(agentConfig, "session", prompt).catch((err) => {
    logAgent(agentConfig, `session failed: ${err.message}`);
    console.error(`  ${agentConfig.handle} session error: ${err.message}`);
    return null;
  });

  const logsDir = path.join(dir, "logs");
  ensureDir(logsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logsDir, `${ts}.log`);

  if (result) {
    writeFileSync(logFile, result);
    logAgent(agentConfig, `session completed (${result.length} chars) → logs/${ts}.log`);
    console.log(`  ${agentConfig.handle} session done → ${logFile}`);
  } else {
    writeFileSync(logFile, "No output or agent_command not configured\n");
    logAgent(agentConfig, "session: no output or agent_command not configured");
  }

  state.last_run = formatDate(Date.now());
  state.next_run_at = nextRunAtFrom(Date.now(), agentConfig.schedule);
  writeState(dir, state);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function allInstances() {
  if (!existsSync(instanceRoot)) return [];
  const entries = readdirSync(instanceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  return platform.restrict_to_config ? entries.filter((h) => agentConfigMap.has(h)) : entries;
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
    if (shouldRun) runNow.push({ template, state });
  }

  console.log(`Scheduler at ${now} (total instances: ${allTracked.length})`);

  if (runNow.length === 0) {
    const upcoming = allTracked
      .filter((i) => i.nextRun)
      .sort((a, b) => Date.parse(a.nextRun) - Date.parse(b.nextRun))
      .slice(0, 5)
      .map((i) => `${i.handle} at ${i.nextRun}`)
      .join(", ");
    console.log(`No agent due now. Next: ${upcoming || "none"}`);
    return;
  }

  // Shuffle agents into random order (Fisher-Yates)
  for (let i = runNow.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [runNow[i], runNow[j]] = [runNow[j], runNow[i]];
  }
  const toRun = runNow.slice(0, Math.max(1, platform.max_parallel_runs));

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
    writeState(instancePath(item.handle), {
      ...item.state,
      next_run_at: item.nextRun || item.state.next_run_at,
      handle: item.handle,
      updated_at: formatDate(Date.now()),
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  ensureDir(instanceRoot);
  const entries = Array.isArray(config.agents) ? config.agents : [];
  if (entries.length === 0) throw new Error(`No agents found in config: ${configPath}`);

  for (const raw of entries) {
    const agent = normalizeAgent(raw, platform);
    console.log(`\n${agent.handle}...`);

    const dir = await ensureAgentFiles(agent);
    const state = readState(dir);

    if (!state.next_run_at) state.next_run_at = initialRunAt(agent.schedule);

    if (agent.api_key) {
      state.api_key = agent.api_key;
      state.registered_at = state.registered_at || formatDate(Date.now());
    }

    if (!state.api_key) {
      try {
        const apiKey = await registerAgent(dir, agent);
        if (apiKey) { state.api_key = apiKey; console.log(`  registered`); }
      } catch (error) {
        console.warn(`  registration failed: ${error.message}`);
      }
    } else {
      console.log(`  already registered`);
    }

    const envPath = path.join(dir, ".env.local");
    if (!existsSync(envPath)) writeFileSync(envPath, generateEnvLocal(agent.handle, state.api_key));
    state.updated_at = formatDate(Date.now());
    writeState(dir, state);
    logAgent(agent, "bootstrapped");
    console.log(`  done: ${dir}`);
  }

  console.log(`\nBootstrap complete. Instances: ${instanceRoot}`);
}

// ---------------------------------------------------------------------------
// Status & help
// ---------------------------------------------------------------------------

async function status() {
  ensureDir(instanceRoot);
  const instances = allInstances();
  if (instances.length === 0) { console.log(`No instances in ${instanceRoot}. Run bootstrap first.`); return; }

  console.log(`instance\tnext_run_at\tstate\tinterval_min\n`);
  for (const handle of instances) {
    const dir = instancePath(handle);
    const a = normalizeAgent(readAgentFromDir(dir) || { handle }, platform);
    const s = readState(dir);
    const next = s.next_run_at || initialRunAt(a.schedule);
    console.log(`${handle}\t${next}\t${isDue(next) ? "due" : "waiting"}\t${a.schedule.interval_minutes}`);
  }
}

function help() {
  console.log(`
BeeHack Simulation Runner

Usage:
  node run-simulation.mjs bootstrap --config agents.json
  node run-simulation.mjs run --config agents.json
  node run-simulation.mjs status --config agents.json

Options:
  --config <path>     Path to config (default agents.example.json)
  --instances <path>  Instance root (default ./instances)
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (command === "help" || command === "--help" || command === "-h") { help(); process.exit(0); }

if (command === "bootstrap") {
  bootstrap().catch((e) => { console.error(`bootstrap failed: ${e.message}`); process.exit(1); });
} else if (command === "run") {
  runScheduler().catch((e) => { console.error(`run failed: ${e.message}`); process.exit(1); });
} else if (command === "status") {
  status().catch((e) => { console.error(`status failed: ${e.message}`); process.exit(1); });
} else {
  help(); process.exit(1);
}
