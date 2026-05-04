#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const execa = require("execa");
const ora = require("ora");
const chalk = require("chalk");
const http = require("http");

const CONFIG_PATH = path.join(__dirname, "config.json");

const DEFAULT_CONFIG = {
  modelDir: path.join(__dirname, "models"),
  host: "127.0.0.1",
  port: 8090,
  threads: 16,
  decodeThreads: 8,
  batchThreads: 16,
  opencode: {
    // Set to false or "notify" to suppress auto-updates
    autoupdate: false,
    // "manual" | "auto" | "disabled"
    share: "disabled",
    // Tool permissions: "allow" | "ask" | "deny"
    // e.g. { "bash": "ask", "edit": "ask" }
    permission: {}
  }
};

// Per-model presets matched by filename substring
// reasoningBudget: 0 = thinking fully disabled, N = hard token cap
// maxNewTokens: used only in CLI mode; server mode uses -1 (unlimited, client controls it)
const MODEL_PRESETS = {
  "Qwen3.5-9B":  { batch: 1024, ubatch: 512, ctx: 65536, maxNewTokens: 16384, reasoningBudget: 0, label: "FAST - recommended" },
  "Qwen3.6-35B": { batch: 512,  ubatch: 256, ctx: 65536, maxNewTokens: 8192,  reasoningBudget: 0, label: "HEAVY - slow" },
  "qwen2.5-coder-14b-instruct-q4_k_m.gguf": { batch: 512, ubatch: 256, ctx: 65536, maxNewTokens: 8192, reasoningBudget: 0, label: "CODER - for code tasks" },
  "Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf": { batch: 512, ubatch: 256, ctx: 65536, maxNewTokens: 8192, reasoningBudget: 0, label: "CODER - for code tasks" }
};

const CONTEXT_OPTIONS = [
  { name: "Compact 32k", value: 32768 },
  { name: "Fast 64k", value: 65536 },
  { name: "Balanced 128k", value: 131072 },
  { name: "Quality 256k", value: 262144 }
];

const OPENCODE_COMPACT_LIMITS = {
  context: 65536,
  output: 4096
};

function getPreset(filename) {
  for (const [key, preset] of Object.entries(MODEL_PRESETS)) {
    if (filename.includes(key)) return preset;
  }
  return { batch: 512, ubatch: 256, ctx: 8192, maxNewTokens: 1024, reasoningBudget: 0, label: "" };
}

function toPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }

  const loadedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH));
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...loadedConfig,
    opencode: {
      ...DEFAULT_CONFIG.opencode,
      ...(loadedConfig.opencode || {})
    }
  };

  mergedConfig.threads = toPositiveInt(mergedConfig.threads, DEFAULT_CONFIG.threads);
  mergedConfig.decodeThreads = toPositiveInt(mergedConfig.decodeThreads, Math.min(8, mergedConfig.threads));
  mergedConfig.batchThreads = toPositiveInt(mergedConfig.batchThreads, Math.max(mergedConfig.decodeThreads, mergedConfig.threads));

  if (JSON.stringify(loadedConfig) !== JSON.stringify(mergedConfig)) {
    saveConfig(mergedConfig);
  }

  return mergedConfig;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Quote a single arg for use inside a cmd /k string
function quoteArg(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Spawn in a new Windows Terminal tab, falling back to a new cmd window
function spawnInNewTab(title, executable, args) {
  const cmdLine = [executable, ...args].map(quoteArg).join(" ");
  // Try Windows Terminal first (gives a tab in the current wt window)
  const wt = execa(
    "wt",
    ["-w", "0", "new-tab", "--title", title, "--", "cmd", "/k", cmdLine],
    { stdio: "ignore", detached: true }
  );
  wt.on("error", () => {
    // wt not available — fall back to a plain new cmd window
    execa("cmd", ["/c", "start", `"${title}"`, "cmd", "/k", cmdLine], {
      stdio: "ignore",
      shell: true,
      detached: true
    });
  });
}

function waitForServer(url) {
  return new Promise((resolve) => {
    const check = () => {
      http.get(url, () => resolve()).on("error", () => {
        setTimeout(check, 1000);
      });
    };
    check();
  });
}

function getRuntimeSettings(preset, profile, contextSize, config) {
  const base = {
    batch: preset.batch,
    ubatch: preset.ubatch,
    ctx: contextSize,
    decodeThreads: config.decodeThreads,
    batchThreads: config.batchThreads
  };

  if (profile === "quality") {
    return {
      ...base,
      decodeThreads: Math.max(base.decodeThreads, Math.min(config.threads, 12)),
      batchThreads: Math.max(base.batchThreads, config.threads)
    };
  }

  if (profile === "balanced") {
    return base;
  }

  // fast profile
  return {
    ...base,
    decodeThreads: Math.min(base.decodeThreads, 8),
    batchThreads: Math.max(base.batchThreads, Math.min(config.threads * 2, 24))
  };
}

async function main() {
  const config = loadConfig();

  console.log(chalk.green("================================"));
  console.log(chalk.green("        Qwen Launcher"));
  console.log(chalk.green("================================\n"));

  // Ask for model directory
  const { modelDir } = await inquirer.prompt([
    {
      type: "input",
      name: "modelDir",
      message: "Model directory:",
      default: config.modelDir
    }
  ]);

  if (!fs.existsSync(modelDir)) {
    console.log(chalk.red("❌ Invalid directory"));
    process.exit(1);
  }

  config.modelDir = modelDir;
  saveConfig(config);

  // Scan models
  const models = fs.readdirSync(modelDir).filter(f => f.endsWith(".gguf"));

  if (models.length === 0) {
    console.log(chalk.red("❌ No .gguf models found"));
    process.exit(1);
  }

  // Select model — show preset label when available
  const { selectedModel } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedModel",
      message: "Select model:",
      choices: models.map(m => {
        const { label } = getPreset(m);
        return { name: label ? `${m}  (${label})` : m, value: m };
      })
    }
  ]);

  const modelPath = path.join(modelDir, selectedModel);
  const modelName = path.parse(selectedModel).name;
  const preset = getPreset(selectedModel);

  const { performanceProfile } = await inquirer.prompt([
    {
      type: "list",
      name: "performanceProfile",
      message: "Performance profile:",
      default: "fast",
      choices: [
        { name: "Fast      (best token/s)", value: "fast" },
        { name: "Balanced  (recommended default)", value: "balanced" },
        { name: "Quality   (slower, better stability)", value: "quality" }
      ]
    }
  ]);

  const contextDefault = performanceProfile === "quality" ? 262144 : performanceProfile === "balanced" ? 131072 : 65536;
  const { selectedContextSize } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedContextSize",
      message: "Context window:",
      default: contextDefault,
      choices: CONTEXT_OPTIONS.map(option => ({ name: option.name, value: option.value }))
    }
  ]);

  const runtime = getRuntimeSettings(preset, performanceProfile, selectedContextSize, config);
  // Keep headroom for system/tool wrappers so OpenCode does not push right to n_ctx.
  const opencodeContextLimit = Math.min(Math.max(2048, runtime.ctx - 4096), OPENCODE_COMPACT_LIMITS.context);
  const opencodeOutputLimit = Math.min(preset.maxNewTokens, OPENCODE_COMPACT_LIMITS.output);

  // Select run mode
  const { mode } = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "Run mode:",
      choices: [
        { name: "Server  (API mode → optionally launches a client)", value: "server" },
        { name: "CLI     (interactive chat in terminal)",             value: "cli" }
      ]
    }
  ]);

  let webUI = false;
  let client = null;

  if (mode === "server") {
    const { enableWebUI } = await inquirer.prompt([
      {
        type: "confirm",
        name: "enableWebUI",
        message: "Enable llama-server web UI?",
        default: false
      }
    ]);
    webUI = enableWebUI;

    const { selectedClient } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedClient",
        message: "Launch client after server starts:",
        choices: [
          { name: "Claude Code",      value: "claude" },
          { name: "OpenCode",         value: "opencode" },
          { name: "None (server only)", value: "none" }
        ]
      }
    ]);
    client = selectedClient;
  }

  console.log(chalk.cyan("\n================================"));
  console.log(`Model  : ${modelName}`);
  console.log(`Profile: ${performanceProfile}`);
  console.log(`Mode   : ${mode === "server" ? "llama-server" : "llama-cli"}`);
  if (mode === "server") {
    console.log(`Web UI : ${webUI ? "enabled" : "disabled"}`);
    console.log(`Client : ${client === "none" ? "none" : client}`);
  }
  console.log(`Batch  : ${runtime.batch}`);
  console.log(`UBatch : ${runtime.ubatch}`);
  console.log(`Threads: decode=${runtime.decodeThreads}, batch=${runtime.batchThreads}`);
  console.log(`Context: ${runtime.ctx}`);
  console.log(chalk.cyan("================================\n"));

  // Flags shared by both modes
  const commonArgs = [
    "-m", modelPath,
    "-ngl", "999",
    "-b", String(runtime.batch),
    "--ubatch-size", String(runtime.ubatch),
    "-t", String(runtime.decodeThreads),
    "-tb", String(runtime.batchThreads),
    "-fa", "on",
    "--ctx-size", String(runtime.ctx),
    "--cache-type-k", "q4_0",
    "--cache-type-v", "q4_0",
    "--temp", "0.6",
    "--top-p", "0.95",
    "--top-k", "20",
    "--min-p", "0.0",
    "--presence-penalty", "0.0",
    "--repeat-penalty", "1.0",
    "--flash-attn", "on",
    "--reasoning-budget", String(preset.reasoningBudget),
    "--reasoning-budget-message", "... thinking budget reached, answering now...",
    "--chat-template-kwargs", JSON.stringify({ "enable_thinking": false }) // Disable llama.cpp's built-in "thinking" feature since it doesn't work well with Claude's prompting and can cause issues with long contexts. We'll rely on the reasoning budget to control thinking instead.
  ];

  // CLI mode — interactive chat, no Claude wrapper
  if (mode === "cli") {
    await execa("llama-cli", [
      ...commonArgs,
      "--n-predict", String(preset.maxNewTokens),
      "--mlock",
      "--repeat-penalty", "1.02"
    ], { stdio: "inherit" });
    return;
  }

  // Server mode — open in a separate tab so logs don't clash with the client
  // --n-predict -1 = unlimited; the client (Claude/OpenCode) controls max_tokens per request
  const serverArgs = [
    ...commonArgs,
    "--n-predict", "-1",
    "--tools", "all",
    "--jinja",
    "--host", config.host,
    "--port", String(config.port),
    ...(!webUI ? ["--no-webui"] : [])
  ];

  spawnInNewTab("Llama Server", "llama-server", serverArgs);

  const spinner = ora("Waiting for llama-server to be ready...").start();
  await waitForServer(`http://${config.host}:${config.port}`);
  spinner.succeed(`Server ready  (see "Llama Server" tab for logs)${webUI ? `  ·  Web UI: http://${config.host}:${config.port}` : ""}`);

  if (client === "none") {
    console.log(chalk.yellow("\nServer running. Close the \"Llama Server\" tab to stop it."));
    return;
  }

  if (client === "claude") {
    const env = {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "not_set",
      ANTHROPIC_API_KEY: "not_set",
      ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
      ANTHROPIC_MODEL: modelName,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "65536"
    };

    console.log(chalk.green("\nLaunching Claude...\n"));

    await execa("claude", ["--model", modelName], {
      stdio: "inherit",
      env
    });

    console.log(chalk.yellow("\nClaude exited. Close the \"Llama Server\" tab to stop the server."));
  } else {
    const oc = config.opencode;
    const opencodeConfig = {
      "$schema": "https://opencode.ai/config.json",
      provider: {
        "llama.cpp": {
          npm: "@ai-sdk/openai-compatible",
          name: "llama-server (local)",
          options: {
            baseURL: `http://${config.host}:${config.port}/v1`
          },
          stream: true,
          models: {
            [modelName]: {
              name: modelName,
              limit: {
                context: opencodeContextLimit,
                output: opencodeOutputLimit
              }
            }
          }
        }
      },
      model: `llama.cpp/${modelName}`
    };

    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig)
    };

    console.log(chalk.green("\nLaunching OpenCode...\n"));
    console.log(chalk.yellow(`OpenCode compact limits: context=${opencodeContextLimit}, output=${opencodeOutputLimit} (server ctx: ${runtime.ctx})`));

    await execa("opencode", [], {
      stdio: "inherit",
      env
    });

    console.log(chalk.yellow("\nOpenCode exited. Close the \"Llama Server\" tab to stop the server."));
  }
}

main();