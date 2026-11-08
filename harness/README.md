# Model Harness

Test any model behind an OpenAI-compatible or Anthropic-format API with Claude Code's system prompts and tools. You get a local web UI and a command-line runner, both using your own API key.

The system prompts and tool descriptions are assembled from [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) (MIT), which extracts them from the Claude Code npm package. The harness renders those fragments, offers the model Claude Code-style tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`) and runs the tool loop, so you can see how a model behaves inside an agent harness like Claude Code's.

## Quick start

Requires Node.js 22+ and git. There are no npm dependencies.

```bash
cd harness
```

```bash
npm run fetch-prompts
```

```bash
cp .env.example .env
```

Edit `.env` and set `HARNESS_API_KEY` (and `HARNESS_BASE_URL` / `HARNESS_API_FORMAT` if your provider differs), then:

```bash
npm start
```

Open the address it prints. On a desktop it opens in your browser automatically. If port 8787 is busy it moves to the next free port, so use the address it prints. The page only works through the server: opening `public/index.html` straight from the folder shows a notice instead. Click **Load models** first: it checks your key and fills the model list with the provider's exact model ids.

You can also leave `.env` empty and paste the key into the UI. It is then sent only to the local harness server, and stored in your browser only if you tick "Remember key".

### apinex.bond / gemini-4-argon

The defaults in `.env.example` are confirmed to work for apinex.bond: base URL `https://apinex.bond/v1`, OpenAI-compatible format, Bearer auth, and model id `gemini-4-argon` (one of 42 models it lists). Other providers may differ:

- **Base URL**: the harness calls `<base>/chat/completions` (openai) or `<base>/messages` (anthropic), and `<base>/models`.
- **Format**: switch to `anthropic` if the provider exposes the Messages API instead.
- **Auth header**: `auto` sends `Authorization: Bearer <key>` for openai and `x-api-key` for anthropic.

Errors from the provider (401, 402 out of balance, 429, …) are shown in full in the chat, with your key redacted.

## The UI

**Chat** runs the agent loop. Each assistant turn shows any streamed reasoning, the text, and tool-call cards with their arguments and results. Each turn also reports time to first token, total time, input and output tokens, and the stop reason.

The **Tool approval** setting controls what runs:

| Mode | Behaviour |
| --- | --- |
| Auto-run read-only, ask before Bash/Write/Edit (default) | `Read`, `Glob`, `Grep`, `TodoWrite` run; the others wait for you |
| Ask before every tool call | every call waits |
| Run every tool call automatically | nothing waits |
| Dry run | nothing executes; the model is told the call was recorded |

On a waiting card you can **Approve**, **Deny**, or **Respond with…** to type the tool result yourself. That's useful for probing how the model reacts to specific outputs without running anything. **Stop** ends the run. **Export JSON** downloads the transcript.

**System prompt** composes what the model sees:

- *Presets* (`presets.json`): Claude Code's main prompt in a lean and a full variant, the Explore, Plan and general-purpose subagent prompts, or no prompt.
- *Sections*: reorder, remove, bullet-ify, add free text or the generated environment block.
- *Fragment library*: search all of the repo's fragments (system prompts, tool descriptions, system reminders, agent prompts, …) and add any of them.
- *Identity line*: change "You are Claude Code, Anthropic's official CLI for Claude." to anything, or clear it.
- *Variables*: fragments contain placeholders like `${READ_TOOL_NAME}`. The harness fills them from defaults in `src/prompts.mjs`, lists any it can't resolve, and lets you override any of them.
- *Tool descriptions*: `compact` (what newer Claude Code builds send) or `classic` (the longer originals).
- *Edit text directly*: freeze the assembled text and hand-edit it.

The assembled prompt, its size, and the exact tool definitions sent to the model are shown live.

**Compare** sends one prompt to several models at once, side by side, using the composed system prompt and optionally the tools. Tool calls are shown, not executed. Use it to see which models call which tools for the same request.

**Saved prompts** (left rail) keep prompts you reuse in your browser.

Every chat and compare run is also written to `harness/runs/*.json`.

## Command line

```bash
node src/cli.mjs -m gemini-4-argon "Create fizzbuzz.py and run it"
```

```bash
node src/cli.mjs --list-models
```

```bash
node src/cli.mjs -p explore-agent --print-system
```

```bash
node src/cli.mjs -a never --format anthropic --tool-style classic "Find every TODO in this project"
```

`node src/cli.mjs --help` lists all options. Approval prompts appear inline (`y` to allow).

## Checking what a provider adds to your prompts

Resellers and gateways sometimes add their own hidden instructions to every request. That changes how a model behaves, and it changes what you are actually testing. To check a model:

```bash
npm run probe -- -m gemini-4-argon
```

The script:

1. **Measures** the added text. It compares the input tokens billed for a 1-token message, a longer one, and one with a system prompt. Official APIs add only a few tokens of framing, so a large fixed remainder means text was added.
2. **Asks** the model about it in several ways, sampling each probe a few times. Models told to keep instructions secret answer inconsistently, so the leaks show up across samples. When a fragment leaks, it asks the model to continue quoting from there. You can also pass a fragment yourself with `--seed "..."`.
3. **Checks** the best verbatim extraction against the measured size, and saves everything to `runs/`.

Treat what comes back as evidence, not proof: models can invent instructions. Trust a rule when it appears in several independent samples and matches the model's behaviour, for example a scripted identity answer it actually gives.

## What is extracted vs. written by the harness

From the prompt repo, rendered as-is: every fragment in `presets.json`, every tool description, and the Bash `description` parameter text.

Written by the harness, because the repo doesn't contain them:

- **Tool input schemas** (`src/tools.mjs`). They follow Claude Code's public tool shapes.
- **The environment block** (working directory, platform, date, model).
- **Tool result wording**: denials, dry-run notices, and errors.
- **Defaults for template variables** (`defaultVariables` in `src/prompts.mjs`). Where possible they pull other fragments from the repo.

The real Claude Code assembles its prompt conditionally at runtime, so the presets approximate it rather than reproduce a specific session byte for byte.

## Safety notes

- **Tool calls run real commands on your machine.** `Read`, `Write`, `Edit`, `Glob` and `Grep` are confined to the workspace folder (`HARNESS_WORKSPACE`, default `harness/workspace`). Symlinks out of it are blocked. **`Bash` is not sandboxed**: it starts in the workspace, but a command can reach anything your user can. Keep the default approval mode, or use a VM or container, when testing models you don't trust.
- Your API key is never sent to the model. It is removed from the environment of `Bash` commands, along with any variable whose name looks like a key, token, secret or password. It is not written to `runs/`.
- The server listens on `127.0.0.1` only. Every API call needs a random per-launch token embedded in the page, so other websites open in your browser can't drive it.
- Only use a third-party API provider you trust with your key and your prompts.

## Offline testing

A scripted fake provider is included, so you can try the UI without spending tokens:

```bash
npm run mock
```

```bash
HARNESS_BASE_URL=http://127.0.0.1:8788/v1 HARNESS_API_KEY=anything npm start
```

The mock calls `Bash` if your prompt contains "bash", `Write` for "write", and `Glob` for "list". Otherwise it echoes the prompt back.

```bash
npm test
```

The test suite covers the template engine, assembly of every preset against the real prompt repo, tool confinement, both API formats with and without streaming, approvals, and error handling.

## Behind a proxy, or on a remote machine

Node's `fetch` ignores `HTTPS_PROXY` unless you opt in:

```bash
NODE_USE_ENV_PROXY=1 npm start
```

The server only accepts requests addressed to `127.0.0.1`/`localhost`, which guards against DNS rebinding. If you reach it through a forwarded port under another hostname, it logs the refused name; allow it with `HARNESS_ALLOWED_HOSTS=that.host` (comma-separated). `HARNESS_OPEN=0` stops it opening a browser.

## Layout

```
harness/
  presets.json            prompt presets (edit freely)
  src/template.mjs        safe interpreter for the ${...} expressions in fragments (no eval)
  src/prompts.mjs         fragment library, variable defaults, prompt + tool assembly
  src/tools.mjs           tool schemas and executors
  src/providers.mjs       OpenAI-compatible and Anthropic adapters (streaming, retries)
  src/agent.mjs           the tool-use loop and approval policies
  src/server.mjs          local web server + API
  src/cli.mjs             command-line runner
  public/                 the web UI (no build step)
  scripts/fetch-prompts.mjs
  scripts/probe-hidden-prompt.mjs   measure and extract text a provider adds to requests
  test/                   mock provider and tests
```
