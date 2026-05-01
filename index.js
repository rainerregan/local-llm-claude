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
  modelDir: "D:\\AI\\Models",
  host: "127.0.0.1",
  port: 8090,
  threads: 16
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
  const models = fs.readdirSync(modelDir)
    .filter(f => f.endsWith(".gguf"));

  if (models.length === 0) {
    console.log(chalk.red("❌ No .gguf models found"));
    process.exit(1);
  }

  // Select model
  const { selectedModel } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedModel",
      message: "Select model:",
      choices: models
    }
  ]);

  const modelPath = path.join(modelDir, selectedModel);
  const modelName = path.parse(selectedModel).name;

  console.log(chalk.cyan(`\nModel: ${modelName}\n`));

  // Start llama-server
  const spinner = ora("Starting llama-server...").start();

  const server = execa("llama-server", [
    "-m", modelPath,
    "--host", config.host,
    "--port", config.port,
    "-ngl", "999",
    "-t", config.threads,
    "--ctx-size", "64000"
  ], {
    stdio: "inherit"
  });

  // Wait until server ready
  await waitForServer(`http://${config.host}:${config.port}`);

  spinner.succeed("Server ready");

  // Setup env
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

  // Cleanup
  server.kill();
}

main();