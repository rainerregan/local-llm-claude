# local-llm-claude

Run **Claude Code** (the Anthropic CLI) fully offline against a local GGUF model served by [llama.cpp](https://github.com/ggerganov/llama.cpp).

---

## How it works

1. An interactive prompt lets you pick a model and run mode.
2. In **Server mode** the launcher starts `llama-server` in a new terminal tab, waits until it is ready, then launches `claude` pointed at the local server — Claude Code behaves normally but every request goes to your local model.
3. In **CLI mode** the launcher starts `llama-cli` directly in the current terminal for a simple interactive chat session.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| [Node.js](https://nodejs.org/) ≥ 18 | Required to run the launcher |
| [llama.cpp](https://github.com/ggerganov/llama.cpp) | `llama-server` and `llama-cli` must be on your `PATH` |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | Must be installed and on your `PATH` |
| A GGUF model file | Place it in the `models/` folder (see below) |

---

## Installation

```bash
npm install
```

---

## Usage

```bash
node index.js
```

Or, if installed globally via `npm install -g .`:

```bash
llm
```

The launcher will ask for:
1. **Model directory** — defaults to `./models` (saved to `config.json` for next time)
2. **Model selection** — lists every `.gguf` file found, with a speed label for recognised models
3. **Run mode** — `Server` (Claude Code) or `CLI` (direct chat)

---

## Recommended models

The `models/` folder includes three pre-configured Qwen models. These are the **recommended defaults** — the launcher has tuned presets (batch size, context window) for each:

| File | Label | Best for |
|---|---|---|
| `Qwen3.5-9B-Q8_0.gguf` | **FAST** | Quick tasks, low VRAM |
| `Qwen3.6-27B-Q4_K_M.gguf` | **BALANCED** | General use |
| `Qwen3.6-35B-A3B-UD-Q3_K_M.gguf` | **HEAVY** | Best quality, slow |

> Any other `.gguf` file dropped into `models/` will also be detected automatically with sensible default settings.

---

## Configuration

Settings are stored in `config.json` and updated automatically by the launcher:

```json
{
  "modelDir": "C:\\Local LLM\\local-llm-claude\\models",
  "host": "127.0.0.1",
  "port": 8090,
  "threads": 16
}
```

| Key | Description |
|---|---|
| `modelDir` | Path scanned for `.gguf` files |
| `host` | Address `llama-server` binds to |
| `port` | Port `llama-server` listens on |
| `threads` | CPU thread count passed to llama.cpp |

---

## Adding models

1. Download any GGUF-format model.
2. Copy it into the `models/` folder (or any folder — you can change the path at startup).
3. Run the launcher; the model will appear in the selection list.

---

## Notes

- GPU layers are set to `999` (`-ngl 999`), offloading as many layers as fit in VRAM.
- KV cache is quantised to `q4_0` to reduce VRAM usage.
- In Server mode, `llama-server` runs in a separate Windows Terminal tab. Close that tab to stop the server after Claude exits.
- The Anthropic API key environment variables are intentionally set to dummy values; the real traffic never leaves your machine.
