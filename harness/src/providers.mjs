// Model API adapters. Internally messages use Anthropic-style content blocks:
//   { role: 'user' | 'assistant', content: string | Block[] }
//   Block = text | tool_use {id,name,input} | tool_result {tool_use_id,content,is_error} | thinking
// Each adapter converts to its wire format and normalizes the reply back.

export const FORMATS = ['openai', 'anthropic'];

export function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function authHeaders({ format, apiKey, authHeader = 'auto' }) {
  if (!apiKey) return {};
  const mode = authHeader === 'auto' ? (format === 'anthropic' ? 'x-api-key' : 'bearer') : authHeader;
  if (mode === 'x-api-key') return { 'x-api-key': apiKey };
  if (mode === 'both') return { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` };
  return { Authorization: `Bearer ${apiKey}` };
}

function redact(text, apiKey) {
  return apiKey && apiKey.length > 6 ? String(text).split(apiKey).join('[REDACTED]') : String(text);
}

async function request(provider, pathname, body, signal) {
  const url = `${normalizeBaseUrl(provider.baseUrl)}${pathname}`;
  const headers = {
    'content-type': 'application/json',
    ...authHeaders(provider),
    ...(provider.format === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
    ...(provider.extraHeaders || {}),
  };
  const retries = provider.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      const cause = e.cause?.code || e.cause?.message || '';
      throw new Error(`Network error calling ${url}: ${e.message}${cause ? ` (${cause})` : ''}`);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (attempt < retries && [429, 500, 502, 503, 504].includes(res.status)) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 15000)));
      continue;
    }
    const err = new Error(`HTTP ${res.status} from ${url}: ${redact(text, provider.apiKey).slice(0, 2000)}`);
    err.status = res.status;
    throw err;
  }
}

// Yields { event, data } for each server-sent event.
async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return { input: {} };
  if (typeof raw === 'object') return { input: raw };
  try {
    const v = JSON.parse(raw);
    return { input: v && typeof v === 'object' ? v : {} };
  } catch (e) {
    return { input: {}, input_error: `Tool arguments were not valid JSON (${e.message}): ${String(raw).slice(0, 500)}` };
  }
}

let idCounter = 0;
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');

// ---------- OpenAI-compatible (/chat/completions) ----------

function toOpenAI(system, messages, tools, model, params) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const toolCalls = m.content.filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: textOf(m.content) || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '') });
      }
      const text = textOf(m.content);
      if (text) out.push({ role: 'user', content: text });
    }
  }
  const body = { model, messages: out };
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (params.temperature !== undefined && params.temperature !== null && params.temperature !== '') body.temperature = Number(params.temperature);
  if (params.top_p) body.top_p = Number(params.top_p);
  if (params.max_tokens) body.max_tokens = Number(params.max_tokens);
  if (params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;
  if (params.stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  return { ...body, ...(params.extraBody || {}) };
}

function openAIUsage(u) {
  if (!u) return null;
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? null,
    output: u.completion_tokens ?? u.output_tokens ?? null,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? null,
    cached: u.prompt_tokens_details?.cached_tokens ?? null,
  };
}

async function callOpenAI(provider, { model, system, tools, messages, params, signal, onEvent }) {
  const t0 = Date.now();
  let ttft = null;
  const mark = () => { if (ttft === null) ttft = Date.now() - t0; };
  const res = await request(provider, '/chat/completions', toOpenAI(system, messages, tools, model, params), signal);
  const blocks = [];
  let text = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  const calls = [];

  if (params.stream && (res.headers.get('content-type') || '').includes('event-stream')) {
    for await (const { data } of sse(res)) {
      if (data === '[DONE]') break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`Stream error: ${redact(JSON.stringify(chunk.error), provider.apiKey)}`);
      if (chunk.usage) usage = openAIUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) { mark(); reasoning += r; onEvent?.({ type: 'reasoning', delta: r }); }
      if (typeof d.content === 'string' && d.content) { mark(); text += d.content; onEvent?.({ type: 'text', delta: d.content }); }
      for (const tc of d.tool_calls || []) {
        mark();
        const i = tc.index ?? calls.length;
        if (!calls[i]) {
          calls[i] = { id: tc.id || newId('call'), name: '', args: '' };
        }
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) {
          const isNew = !calls[i].name;
          calls[i].name += tc.function.name;
          if (isNew) onEvent?.({ type: 'tool_call_start', id: calls[i].id, name: calls[i].name });
        }
        if (tc.function?.arguments) {
          calls[i].args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          onEvent?.({ type: 'tool_call_delta', id: calls[i].id, delta: tc.function.arguments });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } else {
    const json = await res.json();
    mark();
    const msg = json.choices?.[0]?.message || {};
    finish = json.choices?.[0]?.finish_reason ?? null;
    usage = openAIUsage(json.usage);
    reasoning = msg.reasoning_content ?? msg.reasoning ?? '';
    text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : '';
    if (reasoning) onEvent?.({ type: 'reasoning', delta: reasoning });
    if (text) onEvent?.({ type: 'text', delta: text });
    for (const tc of msg.tool_calls || []) {
      calls.push({ id: tc.id || newId('call'), name: tc.function?.name || '', args: tc.function?.arguments ?? '' });
      onEvent?.({ type: 'tool_call_start', id: calls.at(-1).id, name: calls.at(-1).name });
    }
  }

  if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning });
  if (text) blocks.push({ type: 'text', text });
  for (const c of calls.filter(Boolean)) blocks.push({ type: 'tool_use', id: c.id, name: c.name, ...parseArgs(c.args) });
  return { message: { role: 'assistant', content: blocks }, stopReason: finish, usage, timing: { ttftMs: ttft, totalMs: Date.now() - t0 } };
}

// ---------- Anthropic Messages (/messages) ----------

function toAnthropic(system, messages, tools, model, params) {
  const msgs = messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const content = m.content
      .filter((b) => b.type !== 'thinking' || b.signature)
      .map((b) => {
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
        if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, content: String(b.content ?? ''), ...(b.is_error ? { is_error: true } : {}) };
        if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
        return { type: 'text', text: b.text };
      });
    return { role: m.role, content };
  });
  const body = { model, messages: msgs, max_tokens: Number(params.max_tokens) || 8192 };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (params.temperature !== undefined && params.temperature !== null && params.temperature !== '') body.temperature = Number(params.temperature);
  if (params.top_p) body.top_p = Number(params.top_p);
  if (params.stream) body.stream = true;
  return { ...body, ...(params.extraBody || {}) };
}

function anthropicUsage(u, prev = {}) {
  if (!u) return prev;
  return {
    input: u.input_tokens ?? prev.input ?? null,
    output: u.output_tokens ?? prev.output ?? null,
    cached: u.cache_read_input_tokens ?? prev.cached ?? null,
    reasoning: prev.reasoning ?? null,
  };
}

async function callAnthropic(provider, { model, system, tools, messages, params, signal, onEvent }) {
  const t0 = Date.now();
  let ttft = null;
  const mark = () => { if (ttft === null) ttft = Date.now() - t0; };
  const res = await request(provider, '/messages', toAnthropic(system, messages, tools, model, params), signal);
  let blocks = [];
  let stop = null;
  let usage = null;

  if (params.stream && (res.headers.get('content-type') || '').includes('event-stream')) {
    const open = [];
    for await (const { data } of sse(res)) {
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      switch (ev.type) {
        case 'message_start': usage = anthropicUsage(ev.message?.usage); break;
        case 'content_block_start': {
          const cb = ev.content_block || {};
          const b = cb.type === 'tool_use' ? { type: 'tool_use', id: cb.id, name: cb.name, _json: '' }
            : cb.type === 'thinking' ? { type: 'thinking', thinking: cb.thinking || '' }
              : cb.type === 'text' ? { type: 'text', text: cb.text || '' } : null;
          open[ev.index] = b;
          if (b?.type === 'tool_use') { mark(); onEvent?.({ type: 'tool_call_start', id: b.id, name: b.name }); }
          break;
        }
        case 'content_block_delta': {
          const b = open[ev.index];
          const d = ev.delta || {};
          if (!b) break;
          mark();
          if (d.type === 'text_delta') { b.text += d.text; onEvent?.({ type: 'text', delta: d.text }); } else if (d.type === 'thinking_delta') { b.thinking += d.thinking; onEvent?.({ type: 'reasoning', delta: d.thinking }); } else if (d.type === 'signature_delta') { b.signature = (b.signature || '') + d.signature; } else if (d.type === 'input_json_delta') { b._json += d.partial_json; onEvent?.({ type: 'tool_call_delta', id: b.id, delta: d.partial_json }); }
          break;
        }
        case 'message_delta': stop = ev.delta?.stop_reason ?? stop; usage = anthropicUsage(ev.usage, usage || {}); break;
        case 'error': throw new Error(`Stream error: ${redact(JSON.stringify(ev.error), provider.apiKey)}`);
        default: break;
      }
    }
    blocks = open.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      const { _json, ...rest } = b;
      return { ...rest, ...parseArgs(_json) };
    });
  } else {
    const json = await res.json();
    mark();
    stop = json.stop_reason ?? null;
    usage = anthropicUsage(json.usage);
    for (const b of json.content || []) {
      if (b.type === 'text') { blocks.push({ type: 'text', text: b.text }); onEvent?.({ type: 'text', delta: b.text }); } else if (b.type === 'thinking') { blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature }); onEvent?.({ type: 'reasoning', delta: b.thinking }); } else if (b.type === 'tool_use') { blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }); onEvent?.({ type: 'tool_call_start', id: b.id, name: b.name }); }
    }
  }
  return { message: { role: 'assistant', content: blocks }, stopReason: stop, usage, timing: { ttftMs: ttft, totalMs: Date.now() - t0 } };
}

/**
 * One model call.
 * @param {{ baseUrl: string, format: 'openai'|'anthropic', apiKey?: string, authHeader?: string, extraHeaders?: object, retries?: number }} provider
 * @param {{ model: string, system?: string, tools?: object[], messages: object[], params?: object, signal?: AbortSignal, onEvent?: Function }} req
 */
export function callModel(provider, req) {
  const r = { params: {}, ...req };
  return provider.format === 'anthropic' ? callAnthropic(provider, r) : callOpenAI(provider, r);
}

export async function listModels(provider, signal) {
  const res = await request({ ...provider, retries: 0 }, '/models', null, signal);
  const json = await res.json();
  const items = json.data || json.models || [];
  return items.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}
