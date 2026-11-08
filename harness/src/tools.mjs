// Claude Code-style tools. Descriptions are composed from the prompt repo's
// fragments; executors run against a workspace folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;

const bulletFiles = (...ids) => ids.map((file) => ({ file, bullet: true }));

// Description recipes per style. `compact` matches newer Claude Code builds.
const DESCRIPTIONS = {
  Bash: {
    classic: [
      { file: 'tool-description-bash-overview' },
      { file: 'tool-description-bash-prefer-dedicated-tools' },
      ...bulletFiles(
        'tool-description-bash-alternative-file-search',
        'tool-description-bash-alternative-content-search',
        'tool-description-bash-alternative-read-files',
        'tool-description-bash-alternative-edit-files',
        'tool-description-bash-alternative-write-files',
        'tool-description-bash-alternative-communication',
      ),
      { file: 'tool-description-bash-built-in-tools-note' },
      { text: '# Instructions' },
      ...bulletFiles(
        'tool-description-bash-verify-parent-directory',
        'tool-description-bash-quote-file-paths',
        'tool-description-bash-maintain-cwd',
        'tool-description-bash-timeout',
        'tool-description-bash-sleep-run-immediately',
        'tool-description-bash-sleep-keep-short',
        'tool-description-bash-git-avoid-destructive-ops',
        'tool-description-bash-git-never-skip-hooks',
        'tool-description-bash-git-prefer-new-commits',
      ),
    ],
  },
  Read: { classic: [{ file: 'tool-description-readfile' }], compact: [{ file: 'tool-description-readfile-compact' }] },
  Write: { classic: [{ file: 'tool-description-write' }], compact: [{ file: 'tool-description-write-read-existing-file-first' }] },
  Edit: {
    classic: [{ file: 'tool-description-edit' }, { file: 'tool-description-edit-minimal-old-string-guidance' }],
    compact: [{ file: 'tool-description-edit-single-replacement' }],
  },
  Glob: { classic: [{ file: 'tool-description-glob' }], compact: [{ file: 'tool-description-glob-compact' }] },
  Grep: { classic: [{ file: 'tool-description-grep' }], compact: [{ file: 'tool-description-grep-compact' }] },
  TodoWrite: { classic: [{ file: 'tool-description-todowrite' }], compact: [{ file: 'tool-description-todowrite-compact' }] },
};

export function descriptionRecipe(name, style = 'compact') {
  const d = DESCRIPTIONS[name];
  return d?.[style] ?? d?.classic ?? [];
}

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

export function toolSchema(name, renderFragment) {
  switch (name) {
    case 'Bash':
      return {
        type: 'object',
        properties: {
          command: str('The command to execute'),
          timeout: num(`Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS})`),
          description: str(renderFragment('tool-parameter-bash-command-description') || 'Clear, concise description of what this command does in active voice.'),
        },
        required: ['command'],
      };
    case 'Read':
      return {
        type: 'object',
        properties: {
          file_path: str('The absolute path to the file to read'),
          offset: num('The line number to start reading from. Only provide if the file is too large to read at once'),
          limit: num('The number of lines to read. Only provide if the file is too large to read at once.'),
        },
        required: ['file_path'],
      };
    case 'Write':
      return {
        type: 'object',
        properties: {
          file_path: str('The absolute path to the file to write (must be absolute, not relative)'),
          content: str('The content to write to the file'),
        },
        required: ['file_path', 'content'],
      };
    case 'Edit':
      return {
        type: 'object',
        properties: {
          file_path: str('The absolute path to the file to modify'),
          old_string: str('The text to replace'),
          new_string: str('The text to replace it with (must be different from old_string)'),
          replace_all: bool('Replace all occurrences of old_string (default false)'),
        },
        required: ['file_path', 'old_string', 'new_string'],
      };
    case 'Glob':
      return {
        type: 'object',
        properties: {
          pattern: str('The glob pattern to match files against'),
          path: str('The directory to search in. If not specified, the current working directory will be used.'),
        },
        required: ['pattern'],
      };
    case 'Grep':
      return {
        type: 'object',
        properties: {
          pattern: str('The regular expression pattern to search for in file contents'),
          path: str('File or directory to search in (rg PATH). Defaults to current working directory.'),
          glob: str('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
          type: str('File type to search (rg --type). Common types: js, py, rust, go, java, etc.'),
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. Defaults to "files_with_matches".' },
          '-i': bool('Case insensitive search (rg -i)'),
          '-n': bool('Show line numbers in output (rg -n). Requires output_mode: "content". Defaults to true.'),
          '-A': num('Number of lines to show after each match (rg -A). Requires output_mode: "content".'),
          '-B': num('Number of lines to show before each match (rg -B). Requires output_mode: "content".'),
          '-C': num('Number of lines to show before and after each match (rg -C). Requires output_mode: "content".'),
          multiline: bool('Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.'),
          head_limit: num('Limit output to first N lines/entries. Defaults to 250.'),
        },
        required: ['pattern'],
      };
    case 'TodoWrite':
      return {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The updated todo list',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string' },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      };
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export const TOOL_NAMES = Object.keys(DESCRIPTIONS);
export const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite']);

class ToolError extends Error {}

/** Mutable per-conversation state shared by the executors. */
export function createToolContext(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  const root = fs.realpathSync(workspace);
  return { root, cwd: root, readFiles: new Map(), todos: [] };
}

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve symlinks on the nearest existing ancestor so links can't escape the workspace.
function realpathNearest(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function resolveInside(ctx, p, field = 'file_path') {
  if (typeof p !== 'string' || !p) throw new ToolError(`${field} is required`);
  const abs = path.resolve(ctx.cwd, p);
  if (!isInside(ctx.root, realpathNearest(abs))) {
    throw new ToolError(`Path ${p} is outside the harness workspace (${ctx.root}). Only files inside the workspace can be accessed.`);
  }
  return abs;
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n... [output truncated: ${text.length - max} more characters]`;
}

// Strip secrets from the environment handed to model-issued commands.
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^HARNESS_/.test(k) || /(API_?KEY|TOKEN|SECRET|PASSWORD)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function runBash(input, ctx) {
  const command = input.command;
  if (typeof command !== 'string' || !command.trim()) throw new ToolError('command is required');
  const timeout = Math.min(Math.max(Number(input.timeout) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  let note = '';
  if (!fs.existsSync(ctx.cwd) || !isInside(ctx.root, ctx.cwd)) {
    ctx.cwd = ctx.root;
    note = `Shell cwd was reset to ${ctx.root}\n`;
  }
  const marker = `__HARNESS_CWD_${crypto.randomBytes(6).toString('hex')}__`;
  const script = `${command}\n__harness_ec=$?\nprintf '\\n${marker}%s' "$PWD"\nexit $__harness_ec`;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { cwd: ctx.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let timedOut = false;
    const onData = (d) => { if (out.length < MAX_OUTPUT_CHARS * 4) out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ content: `Failed to start bash: ${e.message}`, is_error: true }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const idx = out.lastIndexOf(marker);
      if (idx >= 0) {
        const cwd = out.slice(idx + marker.length).trim();
        out = out.slice(0, idx).replace(/\n$/, '');
        if (cwd) ctx.cwd = cwd;
        if (!isInside(ctx.root, ctx.cwd)) {
          ctx.cwd = ctx.root;
          note += `Shell cwd was reset to ${ctx.root}\n`;
        }
      }
      let text = truncate(out.replace(/\s+$/, ''));
      if (timedOut) text += `${text ? '\n' : ''}Command timed out after ${timeout}ms`;
      else if (code) text += `${text ? '\n' : ''}Exit code ${code}`;
      resolve({ content: (text || '(no output)') + (note ? `\n${note.trim()}` : ''), is_error: timedOut || code !== 0 });
    });
  });
}

async function runRead(input, ctx) {
  const abs = resolveInside(ctx, input.file_path);
  let stat;
  try { stat = await fsp.stat(abs); } catch { throw new ToolError(`File does not exist: ${input.file_path}`); }
  if (stat.isDirectory()) throw new ToolError(`EISDIR: ${input.file_path} is a directory. Use the Bash tool (ls) or Glob to list directories.`);
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new ToolError('This tool cannot read binary files.');
  ctx.readFiles.set(abs, stat.mtimeMs);
  const text = buf.toString('utf8');
  if (text.length === 0) return { content: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>' };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const start = Math.max(1, Math.floor(Number(input.offset) || 1));
  const limit = Math.max(1, Math.floor(Number(input.limit) || MAX_READ_LINES));
  const slice = lines.slice(start - 1, start - 1 + limit);
  if (!slice.length) return { content: `<system-reminder>Warning: the file has ${lines.length} lines; offset ${start} is past the end.</system-reminder>` };
  const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}... [line truncated]` : l}`).join('\n');
  const more = start - 1 + slice.length < lines.length ? `\n\n(File has ${lines.length} lines; showing ${start}-${start - 1 + slice.length}. Use offset/limit to read more.)` : '';
  return { content: body + more };
}

function assertFreshRead(ctx, abs, verb) {
  const seen = ctx.readFiles.get(abs);
  if (seen === undefined) throw new ToolError(`File has not been read yet. Read it first before ${verb} it.`);
  const now = fs.statSync(abs).mtimeMs;
  if (now !== seen) throw new ToolError('File has been modified since it was read, either by the user or by a linter. Read it again before attempting to write it.');
}

async function runWrite(input, ctx) {
  const abs = resolveInside(ctx, input.file_path);
  if (typeof input.content !== 'string') throw new ToolError('content is required');
  const exists = fs.existsSync(abs);
  if (exists) assertFreshRead(ctx, abs, 'writing to');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, input.content);
  ctx.readFiles.set(abs, (await fsp.stat(abs)).mtimeMs);
  return { content: exists ? `The file ${abs} has been updated successfully.` : `File created successfully at: ${abs}` };
}

async function runEdit(input, ctx) {
  const abs = resolveInside(ctx, input.file_path);
  const { old_string: oldStr, new_string: newStr, replace_all: all } = input;
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') throw new ToolError('old_string and new_string are required');
  if (oldStr === newStr) throw new ToolError('No changes to make: old_string and new_string are exactly the same.');
  if (!fs.existsSync(abs)) {
    if (oldStr !== '') throw new ToolError(`File does not exist: ${input.file_path}`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, newStr);
    ctx.readFiles.set(abs, (await fsp.stat(abs)).mtimeMs);
    return { content: `File created successfully at: ${abs}` };
  }
  assertFreshRead(ctx, abs, 'editing');
  const text = await fsp.readFile(abs, 'utf8');
  if (oldStr === '') throw new ToolError('old_string is empty but the file already exists. Provide the text to replace.');
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new ToolError(`String to replace not found in file.\nString: ${oldStr}`);
  if (count > 1 && !all) throw new ToolError(`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldStr}`);
  const updated = all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
  await fsp.writeFile(abs, updated);
  ctx.readFiles.set(abs, (await fsp.stat(abs)).mtimeMs);
  return { content: `The file ${abs} has been updated successfully.${all && count > 1 ? ` (${count} occurrences replaced)` : ''}` };
}

async function runGlob(input, ctx) {
  if (typeof input.pattern !== 'string' || !input.pattern) throw new ToolError('pattern is required');
  const base = input.path ? resolveInside(ctx, input.path, 'path') : ctx.cwd;
  const matches = [];
  for await (const rel of fsp.glob(input.pattern, { cwd: base })) {
    if (/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(rel)) continue;
    const abs = path.join(base, rel);
    try {
      const st = await fsp.stat(abs);
      if (st.isFile()) matches.push([abs, st.mtimeMs]);
    } catch { /* vanished */ }
    if (matches.length > 5000) break;
  }
  if (!matches.length) return { content: 'No files found' };
  matches.sort((a, b) => b[1] - a[1]);
  const shown = matches.slice(0, 100).map((m) => m[0]);
  return { content: shown.join('\n') + (matches.length > 100 ? '\n(Results are truncated. Consider using a more specific path or pattern.)' : '') };
}

function runGrep(input, ctx) {
  if (typeof input.pattern !== 'string' || !input.pattern) throw new ToolError('pattern is required');
  const target = input.path ? resolveInside(ctx, input.path, 'path') : ctx.cwd;
  const mode = input.output_mode || 'files_with_matches';
  const args = ['--hidden', '--glob', '!.git', '--max-columns', '500', '--color', 'never'];
  if (mode === 'files_with_matches') args.push('-l');
  else if (mode === 'count') args.push('-c');
  else {
    if (input['-n'] !== false) args.push('-n');
    for (const f of ['-A', '-B', '-C']) if (Number.isFinite(Number(input[f])) && input[f] !== undefined) args.push(f, String(Math.floor(Number(input[f]))));
  }
  if (input['-i']) args.push('-i');
  if (input.multiline) args.push('-U', '--multiline-dotall');
  if (input.glob) args.push('--glob', String(input.glob));
  if (input.type) args.push('--type', String(input.type));
  args.push('-e', input.pattern, '--', target);
  const headLimit = Number(input.head_limit) || 250;
  return new Promise((resolve) => {
    const child = spawn('rg', args, { cwd: ctx.cwd, env: childEnv() });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT_CHARS * 4) out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ content: 'ripgrep (rg) is not installed on this machine, so Grep is unavailable. Install ripgrep or use Bash.', is_error: true }));
    child.on('close', (code) => {
      if (code === 1) return resolve({ content: mode === 'files_with_matches' ? 'No files found' : 'No matches found' });
      if (code !== 0) return resolve({ content: `rg error: ${err.trim() || `exit ${code}`}`, is_error: true });
      const lines = out.replace(/\n$/, '').split('\n');
      const shown = lines.slice(0, headLimit).join('\n');
      const extra = lines.length > headLimit ? `\n(${lines.length - headLimit} more lines truncated by head_limit)` : '';
      resolve({ content: truncate(mode === 'files_with_matches' ? `Found ${lines.length} file${lines.length === 1 ? '' : 's'}\n${shown}${extra}` : shown + extra) });
    });
  });
}

async function runTodoWrite(input, ctx) {
  if (!Array.isArray(input.todos)) throw new ToolError('todos must be an array');
  ctx.todos = input.todos.map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending'), activeForm: String(t.activeForm ?? '') }));
  return { content: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable' };
}

const EXECUTORS = { Bash: runBash, Read: runRead, Write: runWrite, Edit: runEdit, Glob: runGlob, Grep: runGrep, TodoWrite: runTodoWrite };

/** Execute one tool call. Never throws: failures come back as is_error results. */
export async function executeTool(name, input, ctx) {
  const fn = EXECUTORS[name];
  if (!fn) return { content: `<tool_use_error>No such tool available: ${name}</tool_use_error>`, is_error: true };
  try {
    return await fn(input && typeof input === 'object' ? input : {}, ctx);
  } catch (e) {
    return { content: `<tool_use_error>${e instanceof ToolError ? e.message : `Error: ${e.message}`}</tool_use_error>`, is_error: true };
  }
}
