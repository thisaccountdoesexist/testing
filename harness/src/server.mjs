#!/usr/bin/env node
// Local web UI + API for the harness. Binds to 127.0.0.1 by default.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { PromptLibrary, DEFAULT_PROMPTS_REPO, DEFAULT_IDENTITY, HARNESS_DIR, assemble, loadPresets } from './prompts.mjs';
import { createToolContext, TOOL_NAMES } from './tools.mjs';
import { runAgent, approvalPolicy, sumUsage, repairDangling, APPROVAL_MODES } from './agent.mjs';
import { callModel, listModels, FORMATS } from './providers.mjs';

const config = loadConfig();
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC_DIR = path.join(HARNESS_DIR, 'public');
const library = new PromptLibrary(config.promptsRepo || DEFAULT_PROMPTS_REPO).load();
const runs = new Map();
const toolContexts = new Map();
const MAX_BODY = 20 * 1024 * 1024;

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function providerFrom(body = {}) {
  const p = body.provider || {};
  const format = FORMATS.includes(p.format) ? p.format : config.format;
  return {
    baseUrl: p.baseUrl || config.baseUrl,
    format,
    apiKey: p.apiKey || config.apiKey,
    authHeader: p.authHeader || config.authHeader,
    extraHeaders: p.extraHeaders && typeof p.extraHeaders === 'object' ? p.extraHeaders : undefined,
  };
}

function openStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  return (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
}

function isGitRepo(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

async function saveRun(record) {
  await fsp.mkdir(config.runsDir, { recursive: true });
  const safeModel = String(record.model).replace(/[^\w.-]+/g, '_').slice(0, 60);
  const file = path.join(config.runsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${record.kind}-${safeModel}.json`);
  await fsp.writeFile(file, JSON.stringify(record, null, 2));
  const rel = path.relative(HARNESS_DIR, file);
  return rel.startsWith('..') ? file : rel;
}

async function handleChat(req, res, body) {
  const provider = providerFrom(body);
  const model = String(body.model || config.model);
  const conversationId = String(body.conversationId || 'default');
  if (!toolContexts.has(conversationId)) toolContexts.set(conversationId, createToolContext(config.workspace));
  const toolCtx = toolContexts.get(conversationId);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const run = { pending: new Map(), controller };
  runs.set(runId, run);
  controller.signal.addEventListener('abort', () => {
    for (const resolve of run.pending.values()) resolve({ decision: 'deny', note: 'Run was stopped.' });
    run.pending.clear();
  });
  const emit = openStream(res);
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
    runs.delete(runId);
  });
  emit({ type: 'run', runId, cwd: toolCtx.cwd });

  const ask = (use) => new Promise((resolve) => {
    run.pending.set(use.id, resolve);
    emit({ type: 'approval_request', id: use.id, name: use.name, input: use.input });
  });
  const mode = APPROVAL_MODES[body.approvalMode] ? body.approvalMode : 'ask-writes';
  const started = new Date().toISOString();
  const startLen = messages.length;
  try {
    const result = await runAgent({
      provider, model, system: body.system || '', tools: Array.isArray(body.tools) ? body.tools : [], messages,
      params: body.params || {}, maxTurns: Math.min(Number(body.maxTurns) || 25, 200),
      approval: approvalPolicy(mode, ask), toolCtx, onEvent: emit, signal: controller.signal,
    });
    const totals = sumUsage(result.turns);
    const savedTo = await saveRun({ kind: 'chat', started, model, provider: { baseUrl: provider.baseUrl, format: provider.format }, params: body.params, approvalMode: mode, system: body.system, tools: body.tools, messages: result.messages, newMessagesFrom: startLen, turns: result.turns, totals, stopped: result.stopped });
    emit({ type: 'done', messages: result.messages, turns: result.turns, totals, stopped: result.stopped, savedTo });
  } catch (e) {
    emit({ type: 'error', message: controller.signal.aborted ? 'Stopped.' : e.message, messages: repairDangling(messages) });
  }
  res.end();
}

async function handleCompare(req, res, body) {
  const provider = providerFrom(body);
  const models = [...new Set((body.models || []).map(String).filter(Boolean))].slice(0, 12);
  const emit = openStream(res);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const messages = Array.isArray(body.messages) ? body.messages : [{ role: 'user', content: String(body.prompt || '') }];
  const started = new Date().toISOString();
  const results = await Promise.all(models.map(async (model) => {
    emit({ type: 'start', model });
    try {
      const r = await callModel(provider, {
        model, system: body.system || '', tools: Array.isArray(body.tools) ? body.tools : [], messages: structuredClone(messages),
        params: body.params || {}, signal: controller.signal, onEvent: (e) => emit({ ...e, model }),
      });
      const out = { model, ok: true, message: r.message, usage: r.usage, timing: r.timing, stopReason: r.stopReason };
      emit({ type: 'result', ...out });
      return out;
    } catch (e) {
      const out = { model, ok: false, error: e.message };
      emit({ type: 'result', ...out });
      return out;
    }
  }));
  const savedTo = models.length ? await saveRun({ kind: 'compare', started, model: models.join('+'), provider: { baseUrl: provider.baseUrl, format: provider.format }, params: body.params, system: body.system, tools: body.tools, messages, results }) : null;
  emit({ type: 'done', savedTo });
  res.end();
}

// Blocks DNS-rebinding when bound to loopback. HARNESS_ALLOWED_HOSTS adds names (or * for any).
const EXTRA_HOSTS = String(process.env.HARNESS_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
function hostAllowed(req) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) || EXTRA_HOSTS.includes('*')) return true;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const ok = ['127.0.0.1', 'localhost', '::1', ...EXTRA_HOSTS].includes(host);
  if (!ok && !rejectedHosts.has(host)) {
    rejectedHosts.add(host);
    console.log(`  Refused a request for host "${host}". To allow it, start with HARNESS_ALLOWED_HOSTS=${host}`);
  }
  return ok;
}
const rejectedHosts = new Set();

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!hostAllowed(req)) return send(res, 403, { error: 'Host not allowed' });

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const file = STATIC[url.pathname];
    let data = await fsp.readFile(path.join(PUBLIC_DIR, file), 'utf8');
    if (file === 'index.html') data = data.replace('__HARNESS_TOKEN__', TOKEN);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(data);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
  // Custom header => cross-site pages can't call the API (no CORS preflight approval).
  if (req.headers['x-harness-token'] !== TOKEN) return send(res, 401, { error: 'Missing or invalid harness token. Reload the page.' });

  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, {
      baseUrl: config.baseUrl, format: config.format, authHeader: config.authHeader, model: config.model, hasServerKey: !!config.apiKey,
      workspace: config.workspace, identity: DEFAULT_IDENTITY, toolNames: TOOL_NAMES, approvalModes: APPROVAL_MODES,
      presets: loadPresets(),
      prompts: { available: library.available, count: library.items.size, version: library.version, repoDir: library.repoDir },
    });
  }
  if (req.method === 'GET' && p === '/api/library') return send(res, 200, { items: library.list() });
  if (req.method === 'GET' && p === '/api/library/item') {
    const item = library.get(url.searchParams.get('id') || '');
    return item ? send(res, 200, item) : send(res, 404, { error: 'No such fragment' });
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const body = await readJson(req);

  if (p === '/api/models') {
    try { return send(res, 200, { models: await listModels(providerFrom(body)) }); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === '/api/assemble') {
    const r = assemble(library, {
      sections: Array.isArray(body.sections) ? body.sections : [],
      toolNames: Array.isArray(body.toolNames) ? body.toolNames : [],
      identity: typeof body.identity === 'string' ? body.identity : DEFAULT_IDENTITY,
      vars: body.vars && typeof body.vars === 'object' ? body.vars : {},
      toolStyle: body.toolStyle === 'classic' ? 'classic' : 'compact',
      ctx: { model: body.model || config.model, workspace: config.workspace, isGit: isGitRepo(config.workspace) },
    });
    const toolChars = JSON.stringify(r.tools).length;
    return send(res, 200, { ...r, approxTokens: Math.round((r.system.length + toolChars) / 4) });
  }
  if (p === '/api/chat') return handleChat(req, res, body);
  if (p === '/api/compare') return handleCompare(req, res, body);
  const m = /^\/api\/runs\/([\w-]+)\/(approval|abort)$/.exec(p);
  if (m) {
    const run = runs.get(m[1]);
    if (!run) return send(res, 404, { error: 'Run not found (it may have finished)' });
    if (m[2] === 'abort') { run.controller.abort(); return send(res, 200, { ok: true }); }
    const resolve = run.pending.get(body.toolUseId);
    if (!resolve) return send(res, 404, { error: 'No pending approval with that id' });
    run.pending.delete(body.toolUseId);
    resolve({ decision: ['approve', 'deny', 'result'].includes(body.decision) ? body.decision : 'deny', result: body.result, is_error: !!body.is_error, note: body.note });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/reset') {
    toolContexts.delete(String(body.conversationId || 'default'));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  });
});

function openBrowser(url) {
  if (process.env.HARNESS_OPEN === '0' || !process.stdout.isTTY) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser available */ }
}

function listen(port, attemptsLeft) {
  const onError = (e) => {
    server.off('listening', onListening);
    if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is already in use, trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`Could not start the harness server: ${e.message}`);
      process.exit(1);
    }
  };
  const onListening = () => {
    server.off('error', onError);
    const shown = ['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host === '::1' ? '[::1]' : config.host;
    const url = `http://${shown}:${server.address().port}`;
    console.log(`Model harness running. Open this in your browser:  ${url}`);
    console.log(`  API: ${config.baseUrl} (${config.format}) · default model: ${config.model} · key: ${config.apiKey ? 'set' : 'not set (enter it in the UI)'}`);
    console.log(`  Workspace for tool calls: ${config.workspace}`);
    if (!library.available) console.log('  Prompt library not found. Run: npm run fetch-prompts');
    else console.log(`  Prompt library: ${library.items.size} fragments (Claude Code v${library.version ?? '?'})`);
    console.log('  Press Ctrl+C to stop.');
    openBrowser(url);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, config.host);
}

listen(config.port, process.env.HARNESS_PORT ? 0 : 10);
