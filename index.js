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
  threads: 16
};

// Per-model presets matched by filename substring
const MODEL_PRESETS = {
  "Qwen3.5-9B":  { batch: 512, ctx: 64000, label: "FAST - recommended" },
  "Qwen3.6-27B": { batch: 256, ctx: 4096,  label: "BALANCED" },
  "Qwen3.6-35B": { batch: 128, ctx: 64000, label: "HEAVY - slow" },
};

function getPreset(filename) {
  for (const [key, preset] of Object.entries(MODEL_PRESETS)) {
    if (filename.includes(key)) return preset;
  }
  return { batch: 512, ctx: 8192, label: "" };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH));
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

  // Select run mode
  const { mode } = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "Run mode:",
      choices: [
        { name: "Server  (API mode → launches Claude CLI)", value: "server" },
        { name: "CLI     (interactive chat in terminal)",   value: "cli" }
      ]
    }
  ]);

  console.log(chalk.cyan("\n================================"));
  console.log(`Model  : ${modelName}`);
  console.log(`Mode   : ${mode === "server" ? "llama-server" : "llama-cli"}`);
  console.log(`Batch  : ${preset.batch}`);
  console.log(`Context: ${preset.ctx}`);
  console.log(chalk.cyan("================================\n"));

  // Flags shared by both modes
  const commonArgs = [
    "-m", modelPath,
    "-ngl", "999",
    "-b", String(preset.batch),
    "-t", String(config.threads),
    "-tb", String(config.threads),
    "-fa", "on",
    "--ctx-size", String(preset.ctx),
    "--cache-type-k", "q4_0",
    "--cache-type-v", "q4_0",
    "--temp", "0.2",
    "--top-p", "0.9",
    "--top-k", "40",
    "--min-p", "0.05",
    "--repeat-penalty", "1.1"
  ];

  // CLI mode — interactive chat, no Claude wrapper
  if (mode === "cli") {
    await execa("llama-cli", [
      ...commonArgs,
      "--mlock",
      "--repeat-penalty", "1.02"
    ], { stdio: "inherit" });
    return;
  }

  // Server mode — open in a separate tab so logs don't clash with Claude
  const serverArgs = [
    ...commonArgs,
    "--tools", "all",
    "--jinja",
    "--host", config.host,
    "--port", String(config.port)
  ];

  spawnInNewTab("Llama Server", "llama-server", serverArgs);

  const spinner = ora("Waiting for llama-server to be ready...").start();
  await waitForServer(`http://${config.host}:${config.port}`);
  spinner.succeed("Server ready  (see \"Llama Server\" tab for logs)");

  // Setup Claude env
  const env = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: "not_set",
    ANTHROPIC_API_KEY: "not_set",
    ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
    ANTHROPIC_MODEL: modelName,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000"
  };

  console.log(chalk.green("\nLaunching Claude...\n"));

  await execa("claude", ["--model", modelName], {
    stdio: "inherit",
    env
  });

  console.log(chalk.yellow("\nClaude exited. Close the \"Llama Server\" tab to stop the server."));
}

main();