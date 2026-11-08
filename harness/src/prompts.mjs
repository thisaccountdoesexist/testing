// Loads the Piebald-AI/claude-code-system-prompts fragments and assembles them
// into a system prompt plus tool definitions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from './template.mjs';
import { descriptionRecipe, toolSchema, TOOL_NAMES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './tools.mjs';

export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROMPTS_REPO = path.join(HARNESS_DIR, 'vendor', 'claude-code-system-prompts');
export const DEFAULT_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const CATEGORIES = [
  ['agent-prompt-', 'Agent prompt'],
  ['system-prompt-', 'System prompt'],
  ['system-reminder-', 'System reminder'],
  ['tool-description-', 'Tool description'],
  ['tool-parameter-', 'Tool parameter'],
  ['data-', 'Data'],
  ['skill-', 'Skill'],
];

export function parseFragment(text) {
  const m = /^<!--\n([\s\S]*?)\n-->\n?/.exec(text);
  const meta = { variables: [] };
  if (!m) return { meta, body: text };
  let inVars = false;
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) {
      inVars = kv[1] === 'variables';
      if (!inVars) meta[kv[1]] = unquote(kv[2]);
    } else if (inVars) {
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (item) meta.variables.push(unquote(item[1]));
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

function unquote(v) {
  const s = v.trim();
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export class PromptLibrary {
  constructor(repoDir = DEFAULT_PROMPTS_REPO) {
    this.repoDir = repoDir;
    this.dir = path.join(repoDir, 'system-prompts');
    this.items = new Map();
    this.version = null;
  }

  get available() { return this.items.size > 0; }

  load() {
    this.items.clear();
    if (!fs.existsSync(this.dir)) return this;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.md')) continue;
      const id = f.slice(0, -3);
      const { meta, body } = parseFragment(fs.readFileSync(path.join(this.dir, f), 'utf8'));
      const category = CATEGORIES.find(([p]) => id.startsWith(p))?.[1] ?? 'Other';
      this.items.set(id, { id, name: meta.name || id, description: meta.description || '', ccVersion: meta.ccVersion || '', variables: meta.variables, category, body });
    }
    try {
      const readme = fs.readFileSync(path.join(this.repoDir, 'README.md'), 'utf8');
      this.version = /Claude Code v([\d.]+)/.exec(readme)?.[1] ?? null;
    } catch { /* optional */ }
    return this;
  }

  get(id) { return this.items.get(id); }

  list() {
    return [...this.items.values()].map(({ body, ...rest }) => ({ ...rest, chars: body.length }));
  }
}

function fragmentBody(library, id) {
  return library.get(id)?.body.trim() ?? '';
}

/**
 * Default values for template variables. Values here are harness choices, not
 * extracted text, except where they pull another fragment from the library.
 */
export function defaultVariables(library, ctx = {}) {
  const intro = () => fragmentBody(library, 'system-prompt-agent-intro-collaborative-goals');
  return {
    BASH_TOOL_NAME: 'Bash', READ_TOOL_NAME: 'Read', WRITE_TOOL_NAME: 'Write', EDIT_TOOL_NAME: 'Edit',
    GLOB_TOOL_NAME: 'Glob', GREP_TOOL_NAME: 'Grep', TODOWRITE_TOOL_NAME: 'TodoWrite', AGENT_TOOL_NAME: 'Agent',
    TASK_CREATE_OR_TODOWRITE_TOOL_NAME: 'TodoWrite', SHELL_TOOL_NAME: 'Bash',
    IS_BASH_ENV: true,
    USE_EMBEDDED_TOOLS: false,
    INTERACTIVE_AGENT_INTRO_FN: intro,
    INTRO_VARIANT: 'default',
    OUTPUT_STYLE: null,
    SECURITY_POLICY_INSTRUCTIONS: fragmentBody(library, 'system-prompt-censoring-assistance-with-malicious-activities'),
    SYSTEM_REMINDER_TAG_GUIDANCE_FN: () => 'Tool results and user messages may include <system-reminder> tags. These contain information from the harness and bear no direct relation to the specific tool result or message they appear in.',
    EXPLAINS_SYSTEM_TURNS: false,
    PASTED_CONTENT_TAG_GUIDANCE: '',
    FINAL_TEXT_MESSAGE_GUIDANCE: '',
    MAX_TIMEOUT_MS_FN: () => MAX_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS_FN: () => DEFAULT_TIMEOUT_MS,
    READ_ONLY_SEARCHING_BASH_COMMANDS: '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`',
    MAX_LINES_CONSTANT: 2000,
    CONDITIONAL_LENGTH_NOTE: '- You can optionally pass `offset` and `limit` to read part of a long file.',
    READ_FULL_FILE_NOTE: '- Any lines longer than 2000 characters will be truncated.',
    CAN_READ_PDF_FILES_FN: () => false,
    ADDITIONAL_READ_NOTE: '',
    MODEL_ID: ctx.model ?? '',
    READ_BEFORE_WRITE_NOTE_FN: () => '\n- If this is an existing file, you MUST use the Read tool first to read the file\'s contents. This tool will fail if you did not read the file first.',
    READ_BEFORE_EDIT_NOTE_FN: () => '\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.',
    LINE_NUMBER_PREFIX_FORMAT: 'spaces + line number + tab',
    ADDITIONAL_EDIT_GUIDELINES_NOTE: '',
    IS_TAB_AWARE_READ_SEPARATOR_ENABLED: false,
    SUBAGENT_STEERING_MODE_FN: () => 'none',
  };
}

// User-entered overrides arrive as strings; coerce obvious literals.
function coerce(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return v;
}

export function makeScope(library, { vars = {}, ctx = {} } = {}) {
  const defaults = defaultVariables(library, ctx);
  return (name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = coerce(vars[name]);
      // A function-valued default overridden by text should still be callable.
      return typeof defaults[name] === 'function' ? () => v : v;
    }
    if (Object.prototype.hasOwnProperty.call(defaults, name)) return defaults[name];
    const tool = /^([A-Z0-9_]+)_TOOL_NAME$/.exec(name);
    if (tool) return tool[1].toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    return undefined;
  };
}

export function environmentSection(ctx = {}) {
  const lines = [
    '# Environment',
    'You have been invoked in the following environment: ',
    ` - Primary working directory: ${ctx.workspace ?? process.cwd()}`,
    ` - Is a git repository: ${ctx.isGit ? 'true' : 'false'}`,
    ` - Platform: ${process.platform}`,
    ' - Shell: bash',
    ` - OS Version: ${os.type()} ${os.release()}`,
  ];
  if (ctx.model) lines.push(`You are powered by the model ${ctx.model}.`);
  lines.push('', `Today's date is ${new Date().toISOString().slice(0, 10)}.`);
  return lines.join('\n');
}

/**
 * Render a list of sections ({file, vars?} | {text} | {identity} | {generated}) into text.
 * A section's `vars` override variables for that fragment only.
 * Bullet sections directly under a heading or another bullet join with one newline.
 */
export function renderSections(sections, library, { scope, ctx = {}, identity = DEFAULT_IDENTITY, keepUnresolved = false } = {}) {
  const unresolved = new Set();
  const errors = [];
  const missing = [];
  const rendered = [];
  for (const sec of sections) {
    let text = '';
    if (sec.identity) text = identity ?? '';
    else if (sec.generated === 'environment') text = environmentSection(ctx);
    else if (typeof sec.text === 'string') text = sec.text;
    else if (sec.file) {
      const item = library.get(sec.file);
      if (!item) { missing.push(sec.file); continue; }
      const local = sec.vars && typeof sec.vars === 'object' ? sec.vars : null;
      const secScope = local ? (name) => (Object.prototype.hasOwnProperty.call(local, name) ? local[name] : scope(name)) : scope;
      const r = renderTemplate(item.body, secScope, { keepUnresolved });
      r.unresolved.forEach((u) => unresolved.add(u));
      r.errors.forEach((e) => errors.push(`${sec.file}: ${e}`));
      text = r.text;
    }
    text = text.replace(/^\n+/, '').replace(/\s+$/, '');
    if (!text) continue;
    if (sec.bullet) text = ` - ${text}`;
    rendered.push({ text, bullet: !!sec.bullet, heading: !sec.bullet && /^#+ /.test(text) && !text.includes('\n') });
  }
  let out = '';
  rendered.forEach((r, i) => {
    const prev = rendered[i - 1];
    if (i > 0) out += r.bullet && (prev.bullet || prev.heading) ? '\n' : '\n\n';
    out += r.text;
  });
  return { text: out, unresolved: [...unresolved], errors, missing };
}

/** Build tool definitions ({ name, description, input_schema }) for the given names. */
export function buildTools(names, library, { scope, style = 'compact' } = {}) {
  const renderFragment = (id) => {
    const item = library.get(id);
    return item ? renderTemplate(item.body, scope).text.trim() : '';
  };
  const unresolved = new Set();
  const tools = names.filter((n) => TOOL_NAMES.includes(n)).map((name) => {
    const r = renderSections(descriptionRecipe(name, style), library, { scope });
    r.unresolved.forEach((u) => unresolved.add(u));
    return { name, description: r.text || name, input_schema: toolSchema(name, renderFragment) };
  });
  return { tools, unresolved: [...unresolved] };
}

/**
 * Assemble everything a run needs from a preset or an explicit section list.
 * @returns {{ system: string, tools: object[], unresolved: string[], errors: string[], missing: string[] }}
 */
export function assemble(library, { sections, toolNames = [], identity = DEFAULT_IDENTITY, vars = {}, ctx = {}, toolStyle = 'compact', keepUnresolved = false }) {
  const scope = makeScope(library, { vars, ctx });
  const sys = renderSections(sections, library, { scope, ctx, identity, keepUnresolved });
  const t = buildTools(toolNames, library, { scope, style: toolStyle });
  return {
    system: sys.text,
    tools: t.tools,
    unresolved: [...new Set([...sys.unresolved, ...t.unresolved])].sort(),
    errors: sys.errors,
    missing: sys.missing,
  };
}

export function loadPresets(file = path.join(HARNESS_DIR, 'presets.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
