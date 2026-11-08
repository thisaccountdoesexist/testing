#!/usr/bin/env node
// Headless runner: node src/cli.mjs [options] "your prompt"
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import { loadConfig } from './config.mjs';
import { PromptLibrary, DEFAULT_PROMPTS_REPO, DEFAULT_IDENTITY, assemble, loadPresets } from './prompts.mjs';
import { createToolContext } from './tools.mjs';
import { runAgent, approvalPolicy, sumUsage, APPROVAL_MODES } from './agent.mjs';
import { listModels } from './providers.mjs';

const HELP = `Usage: node src/cli.mjs [options] "prompt"

Options:
  -m, --model <id>          Model id (default: HARNESS_MODEL or gemini-4-argon)
  -p, --preset <id>         System prompt preset (default: claude-code-lean)
      --system-file <path>  Use this file as the system prompt instead of a preset
      --tools <list>        Comma-separated tools, or "none" (default: the preset's)
      --tool-style <s>      compact | classic tool descriptions (default: compact)
      --identity <text>     Replace the first identity line of the prompt
  -a, --approve <mode>      ${Object.keys(APPROVAL_MODES).join(' | ')} (default: ask-writes)
      --max-turns <n>       Stop after n model calls (default: 25)
      --temperature <t>
      --max-tokens <n>
      --no-stream           Disable streaming
      --base-url <url>      API base URL (default: HARNESS_BASE_URL)
      --format <f>          openai | anthropic (default: HARNESS_API_FORMAT)
      --list-models         Print the API's model list and exit
      --print-system        Print the assembled system prompt and exit
      --json                Print the final transcript as JSON
  -h, --help`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', short: 'm' }, preset: { type: 'string', short: 'p', default: 'claude-code-lean' },
    'system-file': { type: 'string' }, tools: { type: 'string' }, 'tool-style': { type: 'string', default: 'compact' },
    identity: { type: 'string' }, approve: { type: 'string', short: 'a', default: 'ask-writes' },
    'max-turns': { type: 'string', default: '25' }, temperature: { type: 'string' }, 'max-tokens': { type: 'string' },
    'no-stream': { type: 'boolean', default: false }, 'base-url': { type: 'string' }, format: { type: 'string' },
    'list-models': { type: 'boolean', default: false }, 'print-system': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  },
});

if (o.help) { console.log(HELP); process.exit(0); }
const config = loadConfig();
const provider = { baseUrl: o['base-url'] || config.baseUrl, format: o.format || config.format, apiKey: config.apiKey, authHeader: config.authHeader };
const model = o.model || config.model;
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s);

if (o['list-models']) {
  console.log((await listModels(provider)).join('\n'));
  process.exit(0);
}

const library = new PromptLibrary(config.promptsRepo || DEFAULT_PROMPTS_REPO).load();
const presets = loadPresets();
const preset = presets[o.preset];
if (!preset && !o['system-file']) { console.error(`Unknown preset "${o.preset}". Available: ${Object.keys(presets).join(', ')}`); process.exit(2); }
if (!library.available && !o['system-file'] && preset.sections.some((s) => s.file)) {
  console.error('Prompt library missing. Run: npm run fetch-prompts');
  process.exit(2);
}
const toolNames = o.tools ? (o.tools === 'none' ? [] : o.tools.split(',').map((s) => s.trim())) : (preset?.tools ?? []);
const built = assemble(library, {
  sections: preset?.sections ?? [], toolNames, identity: o.identity ?? DEFAULT_IDENTITY, toolStyle: o['tool-style'],
  ctx: { model, workspace: config.workspace },
});
const system = o['system-file'] ? fs.readFileSync(o['system-file'], 'utf8') : built.system;
if (o['print-system']) {
  console.log(system);
  console.log(dim(`\n--- tools: ${built.tools.map((t) => t.name).join(', ') || 'none'} · ~${Math.round((system.length + JSON.stringify(built.tools).length) / 4)} tokens`));
  process.exit(0);
}
const prompt = positionals.join(' ') || (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));
if (!prompt.trim()) { console.error(HELP); process.exit(2); }
if (!provider.apiKey) console.error(dim('Warning: HARNESS_API_KEY is not set (put it in harness/.env).'));

const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (use) => {
  if (!rl) return { decision: 'deny', note: 'Non-interactive session; no approval possible.' };
  const a = (await rl.question(`  Allow ${use.name}? [y/N] `)).trim().toLowerCase();
  return { decision: a === 'y' || a === 'yes' ? 'approve' : 'deny' };
};

const toolCtx = createToolContext(config.workspace);
let midLine = false;
const onEvent = (e) => {
  if (e.type === 'text') { process.stdout.write(e.delta); midLine = !e.delta.endsWith('\n'); } else if (e.type === 'reasoning') { process.stdout.write(dim(e.delta)); midLine = true; } else if (e.type === 'tool_pending') {
    if (midLine) process.stdout.write('\n');
    midLine = false;
    console.log(cyan(`● ${e.name}`) + dim(` ${JSON.stringify(e.input).slice(0, 300)}`));
  } else if (e.type === 'tool_result') {
    const text = String(e.content).split('\n').slice(0, 8).join('\n  ');
    console.log(dim(`  ⎿ ${e.is_error ? '[error] ' : ''}${text}${String(e.content).split('\n').length > 8 ? '\n  …' : ''}`));
  } else if (e.type === 'turn_end') {
    if (midLine) process.stdout.write('\n');
    midLine = false;
    const u = e.usage || {};
    console.log(dim(`  [turn ${e.turn}: ${e.timing.totalMs}ms, ttft ${e.timing.ttftMs ?? '-'}ms, in ${u.input ?? '?'} / out ${u.output ?? '?'} tokens, stop: ${e.stopReason ?? '?'}]`));
  }
};

try {
  const result = await runAgent({
    provider, model, system, tools: built.tools, messages: [{ role: 'user', content: prompt }],
    params: { stream: !o['no-stream'], temperature: o.temperature, max_tokens: o['max-tokens'] },
    maxTurns: Number(o['max-turns']) || 25, approval: approvalPolicy(o.approve, ask), toolCtx, onEvent,
  });
  const t = sumUsage(result.turns);
  console.log(dim(`\nDone (${result.stopped}). ${t.calls} call(s), ${t.totalMs}ms, ${t.input} in / ${t.output} out tokens.`));
  if (o.json) console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
