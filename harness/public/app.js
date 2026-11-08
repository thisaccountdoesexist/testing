const TOKEN = document.querySelector('meta[name="harness-token"]').content;
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  return n;
};
const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '14'); s.setAttribute('height', '14');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
};
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(`harness.${k}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(`harness.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(`harness.${k}`); } catch { /* storage unavailable */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-harness-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

async function streamPost(path, body, onEvent, signal) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-token': TOKEN }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}

// Escape first, then apply a few inline rules, so model output can't inject HTML.
function renderMarkdown(text) {
  const wrap = el('div', { class: 'md' });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) { wrap.append(el('pre', {}, el('code', { text: part.replace(/\n$/, '') }))); return; }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const h = /^(#{1,4})\s+(.*)$/.exec(para.trim());
      if (h && !para.trim().includes('\n')) { const n = el(`h${h[1].length}`); n.innerHTML = inline(h[2]); wrap.append(n); continue; }
      const p = el('p');
      p.innerHTML = inline(para.replace(/^\n+|\n+$/g, ''));
      wrap.append(p);
    }
  });
  return wrap;
}

const fmtMs = (ms) => (ms === null || ms === undefined ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
const fmtNum = (n) => (n === null || n === undefined ? '?' : Number(n).toLocaleString());

// ---------------- state ----------------
const state = {
  config: null,
  library: [],
  libById: new Map(),
  assembled: null,
  settings: {},
  prompt: {},
  chat: { conversationId: uuid(), messages: [], running: false, runId: null, controller: null, turnEls: new Map(), totals: null },
  compareModels: store.get('compareModels', []),
  saved: store.get('savedPrompts', []),
  libSelected: null,
};

const SETTING_FIELDS = ['baseUrl', 'format', 'authHeader', 'model', 'temperature', 'maxTokens', 'maxTurns', 'approvalMode'];

function loadSettings(cfg) {
  const s = store.get('settings', {});
  state.settings = {
    baseUrl: s.baseUrl ?? cfg.baseUrl,
    format: s.format ?? cfg.format,
    authHeader: s.authHeader ?? cfg.authHeader ?? 'auto',
    model: s.model ?? cfg.model,
    temperature: s.temperature ?? '',
    maxTokens: s.maxTokens ?? '',
    maxTurns: s.maxTurns ?? 25,
    approvalMode: s.approvalMode ?? 'ask-writes',
    stream: s.stream ?? true,
    apiKey: store.get('apiKey', ''),
    rememberKey: !!store.get('apiKey', ''),
  };
  for (const f of SETTING_FIELDS) $(`#${f}`).value = state.settings[f];
  $('#stream').checked = state.settings.stream;
  $('#apiKey').value = state.settings.apiKey;
  $('#rememberKey').checked = state.settings.rememberKey;
  $('#apiKey').placeholder = cfg.hasServerKey ? 'Using key from harness/.env' : 'Paste your API key';
}

function saveSettings() {
  for (const f of SETTING_FIELDS) state.settings[f] = $(`#${f}`).value;
  state.settings.stream = $('#stream').checked;
  state.settings.apiKey = $('#apiKey').value.trim();
  state.settings.rememberKey = $('#rememberKey').checked;
  const { apiKey, rememberKey, ...persist } = state.settings;
  store.set('settings', persist);
  if (rememberKey && apiKey) store.set('apiKey', apiKey); else store.del('apiKey');
  $('#chatModel').textContent = state.settings.model;
}

const provider = () => ({ baseUrl: state.settings.baseUrl, format: state.settings.format, authHeader: state.settings.authHeader, apiKey: state.settings.apiKey || undefined });
const params = () => ({
  temperature: state.settings.temperature === '' ? undefined : Number(state.settings.temperature),
  max_tokens: state.settings.maxTokens === '' ? undefined : Number(state.settings.maxTokens),
  stream: state.settings.stream,
});

// ---------------- prompt composer ----------------
function presetState(id) {
  const p = state.config.presets[id];
  return { presetId: id, sections: structuredClone(p.sections), toolNames: [...p.tools], identity: state.config.identity, vars: {}, toolStyle: 'compact', manual: null };
}

function renderPromptForm() {
  const sel = $('#preset');
  sel.replaceChildren(...Object.entries(state.config.presets).map(([id, p]) => el('option', { value: id, text: p.label })));
  sel.value = state.prompt.presetId;
  $('#toolStyle').value = state.prompt.toolStyle;
  $('#identity').value = state.prompt.identity;
  $('#toolChecks').replaceChildren(...state.config.toolNames.map((name) => el('label', {},
    el('input', { type: 'checkbox', value: name, checked: state.prompt.toolNames.includes(name), onchange: onToolsChange }), name)));
  renderPromptChrome();
}

function onToolsChange() {
  state.prompt.toolNames = [...document.querySelectorAll('#toolChecks input:checked')].map((i) => i.value);
  promptChanged();
}

function sectionLabel(sec) {
  if (sec.identity) return ['Identity line', 'identity'];
  if (sec.generated === 'environment') return ['Environment (generated)', 'generated'];
  if (typeof sec.text === 'string') return [null, 'text'];
  const item = state.libById.get(sec.file);
  return [item ? item.name : sec.file, item ? `${sec.file}${item.ccVersion ? ` · v${item.ccVersion}` : ''}` : `${sec.file} · not found`];
}

function renderSections() {
  const list = $('#sections');
  list.replaceChildren(...state.prompt.sections.map((sec, i) => {
    const [title, kind] = sectionLabel(sec);
    const main = el('div', { class: 'sec-main' });
    if (title === null) {
      const ta = el('textarea', { rows: Math.min(6, sec.text.split('\n').length + 1), spellcheck: 'false' });
      ta.value = sec.text;
      ta.addEventListener('input', () => { sec.text = ta.value; promptChanged(); });
      main.append(ta);
    } else {
      main.append(el('div', { class: 'sec-title', text: title, title }), el('div', { class: 'sec-kind', text: kind }));
    }
    const move = (d) => () => {
      const j = i + d;
      if (j < 0 || j >= state.prompt.sections.length) return;
      [state.prompt.sections[i], state.prompt.sections[j]] = [state.prompt.sections[j], state.prompt.sections[i]];
      renderSections(); promptChanged();
    };
    return el('li', { class: `sec${sec.file && !state.libById.has(sec.file) ? ' missing' : ''}` }, main,
      el('div', { class: 'sec-btns' },
        el('button', { class: sec.bullet ? 'on' : '', title: 'Render as a bullet item', text: '•', onclick: () => { sec.bullet = !sec.bullet; renderSections(); promptChanged(); } }),
        el('button', { title: 'Move up', onclick: move(-1) }, icon('i-up')),
        el('button', { title: 'Move down', onclick: move(1) }, icon('i-down')),
        el('button', { title: 'Remove', onclick: () => { state.prompt.sections.splice(i, 1); renderSections(); promptChanged(); } }, icon('i-x'))));
  }));
}

function renderVars() {
  const box = $('#vars');
  const unresolved = state.assembled?.unresolved ?? [];
  const names = [...new Set([...unresolved, ...Object.keys(state.prompt.vars)])];
  if (!names.length) { box.replaceChildren(el('p', { class: 'dim small', text: 'Every placeholder is resolved.' })); return; }
  box.replaceChildren(...names.map((name) => {
    const value = el('input', { value: state.prompt.vars[name] ?? '', placeholder: '(empty)', spellcheck: 'false' });
    value.addEventListener('change', () => { state.prompt.vars[name] = value.value; promptChanged(); });
    const isUnresolved = unresolved.includes(name) && !(name in state.prompt.vars);
    return el('div', { class: 'var-row' },
      el('div', {}, el('div', { class: 'mono small', text: name }), isUnresolved ? el('span', { class: 'tag', text: 'unresolved' }) : null),
      value,
      el('button', { class: 'mini', title: 'Remove override', onclick: () => { delete state.prompt.vars[name]; promptChanged(); } }, icon('i-x')));
  }));
}

function renderPromptChrome() {
  const p = state.config.presets[state.prompt.presetId];
  $('#presetDesc').textContent = p?.description ?? '';
  $('#chatPreset').textContent = `· ${p?.label ?? 'custom'}${state.prompt.manual !== null ? ' (edited)' : ''}`;
  $('#manualEdit').checked = state.prompt.manual !== null;
  $('#systemPreview').readOnly = state.prompt.manual === null;
  renderSections();
}

let assembleTimer = null;
let assemblePromise = null;
function promptChanged() {
  store.set('prompt', state.prompt);
  clearTimeout(assembleTimer);
  assembleTimer = setTimeout(() => { assemblePromise = assemblePrompt(); }, 200);
}

async function assemblePrompt() {
  const r = await api('/api/assemble', {
    sections: state.prompt.sections, toolNames: state.prompt.toolNames, identity: state.prompt.identity,
    vars: state.prompt.vars, toolStyle: state.prompt.toolStyle, model: state.settings.model,
  });
  state.assembled = r;
  const system = state.prompt.manual ?? r.system;
  const preview = $('#systemPreview');
  if (document.activeElement !== preview) preview.value = system;
  const approx = Math.round((system.length + JSON.stringify(r.tools).length) / 4);
  $('#promptStats').textContent = `${system.length.toLocaleString()} chars · ${r.tools.length} tools · ~${approx.toLocaleString()} tokens`;
  $('#toolsPreview').textContent = JSON.stringify(r.tools, null, 2);
  renderVars();
  return r;
}

async function currentPrompt() {
  if (assembleTimer) { clearTimeout(assembleTimer); assembleTimer = null; assemblePromise = assemblePrompt(); }
  if (assemblePromise) await assemblePromise;
  if (!state.assembled) await assemblePrompt();
  return { system: state.prompt.manual ?? state.assembled.system, tools: state.assembled.tools };
}

// ---------------- library ----------------
function renderLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const cat = $('#libCategory').value;
  const items = state.library.filter((it) => (!cat || it.category === cat) && (!q || `${it.name} ${it.description} ${it.id}`.toLowerCase().includes(q)));
  $('#libCount').textContent = `${items.length} / ${state.library.length}`;
  $('#libList').replaceChildren(...items.slice(0, 300).map((it) => el('li', { class: it.id === state.libSelected ? 'sel' : '', onclick: () => previewFragment(it.id) },
    el('span', { class: 'n', text: it.name }),
    el('span', { class: 'd', text: it.description }),
    el('span', { class: 'meta', text: `${it.category} · ${it.chars.toLocaleString()} chars${it.ccVersion ? ` · v${it.ccVersion}` : ''}` }))));
}

async function previewFragment(id) {
  state.libSelected = id;
  renderLibrary();
  const item = await api(`/api/library/item?id=${encodeURIComponent(id)}`);
  $('#libPreview').hidden = false;
  $('#libPreviewName').textContent = item.name;
  $('#libPreviewDesc').textContent = `${item.description}${item.variables?.length ? `  Variables: ${item.variables.join(', ')}` : ''}`;
  $('#libPreviewBody').textContent = item.body;
}

// ---------------- chat ----------------
const transcript = $('#transcript');
const scrollDown = () => { transcript.scrollTop = transcript.scrollHeight; };
const nearBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;

function setRunning(on) {
  state.chat.running = on;
  $('#sendBtn').disabled = on;
  $('#stopBtn').hidden = !on;
  $('#runDot').className = `dot${on ? ' live' : ''}`;
}

function summarizeInput(name, input = {}) {
  if (name === 'Bash') return input.command ?? '';
  if (['Read', 'Write', 'Edit'].includes(name)) return input.file_path ?? '';
  if (name === 'Glob') return input.pattern ?? '';
  if (name === 'Grep') return `${input.pattern ?? ''}${input.path ? `  in ${input.path}` : ''}`;
  if (name === 'TodoWrite') return `${input.todos?.length ?? 0} items`;
  return JSON.stringify(input);
}

function turnView(turn) {
  let v = state.chat.turnEls.get(turn);
  if (v) return v;
  const root = el('div', { class: 'msg msg-assistant' }, el('div', { class: 'msg-label', text: `${state.settings.model} · turn ${turn}` }));
  v = { root, reasoning: null, reasoningPre: null, text: null, textBuf: '', textEl: null, tools: new Map(), body: el('div', { class: 'turn-body' }) };
  root.append(v.body);
  transcript.append(root);
  state.chat.turnEls.set(turn, v);
  return v;
}

function appendText(v, delta) {
  if (!v.textEl || v.textEl.dataset.closed) {
    v.textBuf = '';
    v.textEl = el('div', { class: 'md caret' });
    v.body.append(v.textEl);
  }
  v.textBuf += delta;
  const md = renderMarkdown(v.textBuf);
  md.classList.add('caret');
  v.textEl.replaceWith(md);
  v.textEl = md;
}

function closeText(v) {
  if (v.textEl) { v.textEl.classList.remove('caret'); v.textEl.dataset.closed = '1'; }
}

function toolCard(v, id, name) {
  let card = v.tools.get(id);
  if (card) return card;
  closeText(v);
  const root = el('div', { class: 'tool' });
  card = {
    root, name,
    state: el('span', { class: 'tool-state', text: 'calling' }),
    sum: el('span', { class: 'tool-sum' }),
    body: el('div', { class: 'tool-body' }),
    args: '',
    argsPre: el('pre', {}),
    approval: null,
  };
  root.append(el('div', { class: 'tool-head' }, el('span', { class: 'tool-name', text: name }), card.sum, card.state), card.body);
  card.body.append(card.argsPre);
  v.body.append(root);
  v.tools.set(id, card);
  return card;
}

function setToolInput(card, input) {
  card.sum.textContent = summarizeInput(card.name, input);
  card.sum.title = card.sum.textContent;
  const show = { ...input };
  card.argsPre.textContent = card.name === 'Bash' ? `$ ${input.command ?? ''}${input.description ? `\n# ${input.description}` : ''}` : JSON.stringify(show, null, 2);
}

function showApproval(card, runId, id) {
  card.state.textContent = 'needs approval';
  card.state.className = 'tool-state wait';
  const respond = el('textarea', { rows: 3, placeholder: 'Text to return to the model as this tool\'s result', hidden: true });
  const decide = async (decision, extra = {}) => {
    const box = card.approval;
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api(`/api/runs/${runId}/approval`, { toolUseId: id, decision, ...extra });
      box.remove();
      if (card.approval === box) card.approval = null;
      if (!card.done) card.state.textContent = decision === 'approve' ? 'running' : decision === 'deny' ? 'denied' : 'manual result';
    } catch (e) {
      box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      card.state.textContent = e.message;
    }
  };
  const sendManual = el('button', { class: 'btn small', text: 'Send result', hidden: true, onclick: () => decide('result', { result: respond.value }) });
  card.approval = el('div', { class: 'approval' },
    el('span', { class: 'q', text: `Run ${card.name}?` }),
    el('button', { class: 'btn small go', text: 'Approve', onclick: () => decide('approve') }),
    el('button', { class: 'btn small danger', text: 'Deny', onclick: () => decide('deny') }),
    el('button', { class: 'btn small ghost', text: 'Respond with…', onclick: () => { respond.hidden = false; sendManual.hidden = false; respond.focus(); } }),
    respond, sendManual);
  card.root.append(card.approval);
}

function showResult(card, e) {
  card.done = true;
  card.approval?.remove();
  card.approval = null;
  card.state.textContent = e.is_error ? (e.decision === 'deny' ? 'denied' : 'error') : 'done';
  card.state.className = `tool-state ${e.is_error ? 'bad' : 'ok'}`;
  const text = String(e.content ?? '');
  const res = el('div', { class: `tool-result${e.is_error ? ' err' : ''}` }, el('pre', { text: text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text }));
  card.body.append(res);
}

function renderTodos(todos) {
  const box = $('#todos');
  if (!todos?.length) { box.hidden = true; return; }
  box.hidden = false;
  const mark = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };
  box.replaceChildren(...todos.map((t) => el('div', { class: `todo ${t.status}` }, el('span', { class: 'box', text: mark[t.status] ?? '[ ]' }), el('span', { text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content }))));
}

function updateTotals() {
  const t = state.chat.totals;
  $('#chatTotals').textContent = t ? `${t.calls} calls · ${fmtNum(t.input)} in / ${fmtNum(t.output)} out` : '';
}

function addUserBubble(text) {
  $('#chatEmpty')?.remove();
  transcript.append(el('div', { class: 'msg msg-user', text }));
}

function handleChatEvent(e) {
  const stick = nearBottom();
  switch (e.type) {
    case 'run': state.chat.runId = e.runId; break;
    case 'turn_start': turnView(e.turn); break;
    case 'reasoning': {
      const v = turnView(e.turn);
      if (!v.reasoning) {
        v.reasoningPre = el('pre', {});
        v.reasoning = el('details', { class: 'reasoning' }, el('summary', { text: 'Reasoning' }), v.reasoningPre);
        v.body.prepend(v.reasoning);
      }
      v.reasoningPre.textContent += e.delta;
      break;
    }
    case 'text': appendText(turnView(e.turn), e.delta); break;
    case 'tool_call_start': toolCard(turnView(e.turn), e.id, e.name); break;
    case 'tool_call_delta': {
      const card = toolCard(turnView(e.turn), e.id, '');
      card.args += e.delta;
      card.argsPre.textContent = card.args;
      break;
    }
    case 'turn_end': {
      const v = turnView(e.turn);
      closeText(v);
      for (const b of e.message.content) {
        if (b.type === 'tool_use') {
          const card = toolCard(v, b.id, b.name);
          card.name = b.name;
          card.root.querySelector('.tool-name').textContent = b.name;
          setToolInput(card, b.input);
        }
      }
      const u = e.usage || {};
      v.root.append(el('div', { class: 'metrics' },
        el('span', { text: `ttft ${fmtMs(e.timing?.ttftMs)}` }), el('span', { text: `total ${fmtMs(e.timing?.totalMs)}` }),
        el('span', { text: `in ${fmtNum(u.input)}` }), el('span', { text: `out ${fmtNum(u.output)}` }),
        u.reasoning ? el('span', { text: `reasoning ${fmtNum(u.reasoning)}` }) : null,
        u.cached ? el('span', { text: `cached ${fmtNum(u.cached)}` }) : null,
        el('span', { text: `stop ${e.stopReason ?? '?'}` })));
      break;
    }
    case 'tool_pending': {
      const card = toolCard(turnView(e.turn), e.id, e.name);
      if (!card.sum.textContent) setToolInput(card, e.input || {});
      card.state.textContent = 'queued';
      break;
    }
    case 'approval_request': {
      for (const v of state.chat.turnEls.values()) {
        const card = v.tools.get(e.id);
        if (card) showApproval(card, state.chat.runId, e.id);
      }
      break;
    }
    case 'tool_result': {
      const card = turnView(e.turn).tools.get(e.id);
      if (card) showResult(card, e);
      if (e.todos) renderTodos(e.todos);
      break;
    }
    case 'done': {
      state.chat.messages = e.messages;
      const t = e.totals;
      const prev = state.chat.totals;
      state.chat.totals = prev ? { calls: prev.calls + t.calls, input: prev.input + t.input, output: prev.output + t.output } : t;
      updateTotals();
      $('#savedPath').textContent = e.savedTo ? `saved ${e.savedTo}` : '';
      if (e.stopped === 'max_turns') transcript.append(el('div', { class: 'banner', text: `Stopped after reaching the max turns limit (${state.settings.maxTurns}).` }));
      $('#runDot').className = 'dot ok';
      break;
    }
    case 'error': {
      if (Array.isArray(e.messages)) state.chat.messages = e.messages;
      transcript.append(el('div', { class: 'banner', text: e.message }));
      $('#runDot').className = 'dot err';
      break;
    }
    default: break;
  }
  if (stick) scrollDown();
}

async function sendChat(text) {
  saveSettings();
  if (!state.settings.model) { alert('Set a model id first.'); return; }
  const { system, tools } = await currentPrompt();
  addUserBubble(text);
  state.chat.messages.push({ role: 'user', content: text });
  state.chat.turnEls = new Map();
  state.chat.controller = new AbortController();
  setRunning(true);
  scrollDown();
  try {
    await streamPost('/api/chat', {
      provider: provider(), model: state.settings.model, system, tools, messages: state.chat.messages,
      params: params(), maxTurns: Number(state.settings.maxTurns) || 25, approvalMode: state.settings.approvalMode,
      conversationId: state.chat.conversationId,
    }, handleChatEvent, state.chat.controller.signal);
  } catch (e) {
    if (e.name !== 'AbortError') handleChatEvent({ type: 'error', message: e.message });
  } finally {
    for (const v of state.chat.turnEls.values()) closeText(v);
    setRunning(false);
    state.chat.runId = null;
  }
}

async function stopChat() {
  if (state.chat.runId) await api(`/api/runs/${state.chat.runId}/abort`, {}).catch(() => {});
}

function newChat() {
  if (state.chat.running) return;
  api('/api/reset', { conversationId: state.chat.conversationId }).catch(() => {});
  state.chat = { conversationId: uuid(), messages: [], running: false, runId: null, controller: null, turnEls: new Map(), totals: null };
  transcript.replaceChildren(el('div', { class: 'empty', id: 'chatEmpty' },
    el('p', { class: 'empty-title', text: 'New conversation.' }),
    el('p', { class: 'dim', text: `Tool calls run inside ${state.config.workspace}.` })));
  renderTodos([]);
  updateTotals();
  $('#savedPath').textContent = '';
  $('#runDot').className = 'dot';
}

async function exportChat() {
  const { system, tools } = await currentPrompt();
  const { apiKey, rememberKey, ...settings } = state.settings;
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings, preset: state.prompt.presetId, system, tools, messages: state.chat.messages, totals: state.chat.totals }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `harness-${state.settings.model}-${Date.now()}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------- saved prompts ----------------
function renderSaved() {
  $('#savedEmpty').hidden = state.saved.length > 0;
  $('#savedPrompts').replaceChildren(...state.saved.map((s, i) => el('li', {},
    el('button', { class: 'name', text: s.name, title: s.text, onclick: () => { const inp = $('#input'); inp.value = s.text; inp.focus(); $('#cmpPrompt').value = s.text; } }),
    el('button', { class: 'x-btn', title: 'Delete', onclick: () => { state.saved.splice(i, 1); store.set('savedPrompts', state.saved); renderSaved(); } }, icon('i-x')))));
}

// ---------------- compare ----------------
function renderChips() {
  store.set('compareModels', state.compareModels);
  $('#cmpChips').replaceChildren(...(state.compareModels.length ? state.compareModels.map((m, i) => el('span', { class: 'chip' }, m,
    el('button', { class: 'x-btn', title: `Remove ${m}`, onclick: () => { state.compareModels.splice(i, 1); renderChips(); } }, icon('i-x'))))
    : [el('span', { class: 'dim small', text: 'No models selected. Add model ids below (Load models fills the suggestions).' })]));
}

async function runCompare() {
  saveSettings();
  const prompt = $('#cmpPrompt').value.trim();
  if (!prompt || !state.compareModels.length) { $('#cmpStatus').textContent = 'Add at least one model and a prompt.'; return; }
  const { system, tools } = await currentPrompt();
  const cols = new Map();
  const grid = $('#cmpResults');
  grid.replaceChildren(...state.compareModels.map((m) => {
    const c = { dot: el('span', { class: 'dot live' }), reasoning: null, text: el('div', {}), buf: '', calls: el('div', { class: 'tool-body' }), metrics: el('div', { class: 'metrics' }) };
    c.root = el('div', { class: 'cmp-col' }, el('header', {}, c.dot, m), c.text, c.calls, c.metrics);
    cols.set(m, c);
    return c.root;
  }));
  $('#cmpRun').disabled = true;
  $('#cmpStatus').textContent = 'running…';
  const t0 = performance.now();
  try {
    await streamPost('/api/compare', {
      provider: provider(), models: state.compareModels, prompt,
      system: $('#cmpSystem').checked ? system : '', tools: $('#cmpTools').checked ? tools : [], params: params(),
    }, (e) => {
      const c = cols.get(e.model);
      if (e.type === 'done') { $('#cmpStatus').textContent = `finished in ${fmtMs(Math.round(performance.now() - t0))}${e.savedTo ? ` · saved ${e.savedTo}` : ''}`; return; }
      if (!c) return;
      if (e.type === 'reasoning') {
        if (!c.reasoning) { c.reasoningPre = el('pre', {}); c.reasoning = el('details', { class: 'reasoning' }, el('summary', { text: 'Reasoning' }), c.reasoningPre); c.text.before(c.reasoning); }
        c.reasoningPre.textContent += e.delta;
      } else if (e.type === 'text') {
        c.buf += e.delta;
        const md = renderMarkdown(c.buf);
        c.text.replaceWith(md);
        c.text = md;
      } else if (e.type === 'result') {
        c.dot.className = `dot ${e.ok ? 'ok' : 'err'}`;
        if (!e.ok) { c.root.append(el('div', { class: 'banner', text: e.error })); return; }
        for (const b of e.message.content.filter((x) => x.type === 'tool_use')) {
          c.calls.append(el('div', { class: 'tool' }, el('div', { class: 'tool-head' }, el('span', { class: 'tool-name', text: b.name }), el('span', { class: 'tool-sum', text: summarizeInput(b.name, b.input) }), el('span', { class: 'tool-state', text: 'not run' })),
            el('div', { class: 'tool-body' }, el('pre', { text: JSON.stringify(b.input, null, 2) }))));
        }
        const u = e.usage || {};
        c.metrics.replaceChildren(el('span', { text: `ttft ${fmtMs(e.timing?.ttftMs)}` }), el('span', { text: `total ${fmtMs(e.timing?.totalMs)}` }),
          el('span', { text: `in ${fmtNum(u.input)}` }), el('span', { text: `out ${fmtNum(u.output)}` }), el('span', { text: `stop ${e.stopReason ?? '?'}` }));
      }
    });
  } catch (e) {
    $('#cmpStatus').textContent = e.message;
  } finally {
    $('#cmpRun').disabled = false;
  }
}

// ---------------- wiring ----------------
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  for (const p of ['chat', 'prompt', 'compare']) $(`#panel-${p}`).hidden = p !== name;
  store.set('tab', name);
}

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

async function init() {
  applyTheme(store.get('theme', null));
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  let cfg;
  try { cfg = await api('/api/config'); } catch (e) {
    transcript.replaceChildren(el('div', { class: 'banner', text: `Could not reach the harness server: ${e.message}` }));
    return;
  }
  state.config = cfg;
  $('#approvalMode').replaceChildren(...Object.entries(cfg.approvalModes).map(([k, v]) => el('option', { value: k, text: v })));
  $('#workspacePath').textContent = cfg.workspace;
  $('#libStatus').textContent = cfg.prompts.available ? `${cfg.prompts.count} prompt fragments · Claude Code v${cfg.prompts.version ?? '?'}` : 'prompt library missing: run npm run fetch-prompts';
  loadSettings(cfg);
  saveSettings();
  for (const id of [...SETTING_FIELDS, 'stream', 'apiKey', 'rememberKey']) $(`#${id}`).addEventListener('change', saveSettings);
  $('#model').addEventListener('change', promptChanged);

  const lib = await api('/api/library');
  state.library = lib.items.sort((a, b) => a.name.localeCompare(b.name));
  state.libById = new Map(state.library.map((i) => [i.id, i]));
  $('#libCategory').append(...[...new Set(state.library.map((i) => i.category))].sort().map((c) => el('option', { value: c, text: c })));
  $('#libSearch').addEventListener('input', renderLibrary);
  $('#libCategory').addEventListener('change', renderLibrary);
  $('#libAdd').addEventListener('click', () => {
    if (!state.libSelected) return;
    state.prompt.sections.push({ file: state.libSelected });
    renderSections(); promptChanged();
  });
  renderLibrary();

  const savedPrompt = store.get('prompt', null);
  state.prompt = savedPrompt && cfg.presets[savedPrompt.presetId] ? savedPrompt : presetState('claude-code-lean');
  renderPromptForm();
  $('#preset').addEventListener('change', (e) => { state.prompt = presetState(e.target.value); renderPromptForm(); promptChanged(); });
  $('#resetPreset').addEventListener('click', () => { state.prompt = presetState(state.prompt.presetId); renderPromptForm(); promptChanged(); });
  $('#toolStyle').addEventListener('change', (e) => { state.prompt.toolStyle = e.target.value; promptChanged(); });
  $('#identity').addEventListener('input', (e) => { state.prompt.identity = e.target.value; promptChanged(); });
  $('#addText').addEventListener('click', () => { state.prompt.sections.push({ text: '' }); renderSections(); promptChanged(); });
  $('#addEnv').addEventListener('click', () => { state.prompt.sections.push({ generated: 'environment' }); renderSections(); promptChanged(); });
  $('#addVar').addEventListener('click', () => {
    const name = prompt('Variable name (e.g. BASH_TOOL_NAME)');
    if (name && /^[A-Z0-9_]+$/i.test(name.trim())) { state.prompt.vars[name.trim()] = ''; promptChanged(); }
  });
  $('#manualEdit').addEventListener('change', (e) => {
    state.prompt.manual = e.target.checked ? $('#systemPreview').value : null;
    renderPromptChrome(); promptChanged();
  });
  $('#systemPreview').addEventListener('input', (e) => {
    if (state.prompt.manual !== null) { state.prompt.manual = e.target.value; store.set('prompt', state.prompt); }
  });
  assemblePromise = assemblePrompt();

  $('#loadModels').addEventListener('click', async () => {
    saveSettings();
    $('#modelsStatus').textContent = 'loading…';
    try {
      const { models } = await api('/api/models', { provider: provider() });
      $('#modelList').replaceChildren(...models.map((m) => el('option', { value: m })));
      $('#modelsStatus').textContent = `${models.length} models`;
    } catch (e) {
      $('#modelsStatus').textContent = e.message.slice(0, 160);
    }
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#input').value.trim();
    if (!text || state.chat.running) return;
    $('#input').value = '';
    sendChat(text);
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#stopBtn').addEventListener('click', stopChat);
  $('#newChat').addEventListener('click', newChat);
  $('#exportBtn').addEventListener('click', exportChat);
  $('#savePrompt').addEventListener('click', () => {
    const text = $('#input').value.trim();
    if (!text) return;
    const name = window.prompt('Name for this prompt', text.slice(0, 40));
    if (!name) return;
    state.saved.push({ name, text });
    store.set('savedPrompts', state.saved);
    renderSaved();
  });
  renderSaved();

  $('#cmpAdd').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (v && !state.compareModels.includes(v)) { state.compareModels.push(v); renderChips(); }
    e.target.value = '';
  });
  $('#cmpRun').addEventListener('click', runCompare);
  if (!state.compareModels.length && state.settings.model) state.compareModels.push(state.settings.model);
  renderChips();

  selectTab(store.get('tab', 'chat'));
}

init();
