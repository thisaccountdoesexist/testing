#!/usr/bin/env node
// A scripted fake model API (OpenAI-compatible + Anthropic) for offline testing.
// Rules for the latest user text: contains "bash" -> Bash call, "write" -> Write
// call, "list" -> Glob call, "bad json" -> malformed tool args; otherwise echoes.
// After a tool result it replies with a summary of that result.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

function decide(lastUserText, lastToolResult, hasTools) {
  if (lastToolResult !== null) return { text: `Tool said: ${lastToolResult.slice(0, 200)}` };
  const t = lastUserText.toLowerCase();
  if (hasTools && t.includes('bash')) return { text: 'Running a command.', tool: { name: 'Bash', args: { command: 'echo hello-from-bash && pwd', description: 'Print a greeting' } } };
  if (hasTools && t.includes('write')) return { tool: { name: 'Write', args: { file_path: 'hello.txt', content: 'hi there\n' } } };
  if (hasTools && t.includes('list')) return { tool: { name: 'Glob', args: { pattern: '**/*' } } };
  if (hasTools && t.includes('bad json')) return { tool: { name: 'Read', rawArgs: '{"file_path": ' } };
  return { text: `Echo: ${lastUserText}` };
}

function chunks(s, n = 7) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function lastUser(messages, format) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (format === 'openai' && m.role === 'tool') return { text: '', tool: String(m.content) };
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, tool: null };
    const tr = m.content.find((b) => b.type === 'tool_result');
    if (tr) return { text: '', tool: String(tr.content) };
    return { text: m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), tool: null };
  }
  return { text: '', tool: null };
}

export function startMock({ port = 0, delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const auth = req.headers.authorization || req.headers['x-api-key'];
    if (!auth || String(auth).includes('bad-key')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gemini-4-argon' }, { id: 'mock-small' }, { id: 'mock-large' }] }));
    }
    const format = req.url.endsWith('/messages') ? 'anthropic' : 'openai';
    const { text: userText, tool: toolResult } = lastUser(body.messages || [], format);
    const plan = decide(userText, toolResult, !!body.tools?.length);
    if (body.model === 'mock-error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'boom' } }));
    }
    const prefix = body.model === 'mock-large' ? '[large] ' : '';
    const text = plan.text ? prefix + plan.text : '';
    const callId = `call_${requests.length}`;
    const args = plan.tool ? (plan.tool.rawArgs ?? JSON.stringify(plan.tool.args)) : '';
    const usage = { in: 100 + JSON.stringify(body).length / 50 | 0, out: 20 };
    const wait = () => new Promise((r) => setTimeout(r, delayMs));

    if (format === 'openai') {
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: text || null, ...(plan.tool ? { tool_calls: [{ id: callId, type: 'function', function: { name: plan.tool.name, arguments: args } }] } : {}) }, finish_reason: plan.tool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: usage.in, completion_tokens: usage.out },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { reasoning_content: 'thinking...' } }] });
      for (const c of chunks(text)) { await wait(); send({ choices: [{ delta: { content: c } }] }); }
      if (plan.tool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name: plan.tool.name, arguments: '' } }] } }] });
        for (const c of chunks(args, 5)) send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: c } }] } }] });
      }
      send({ choices: [{ delta: {}, finish_reason: plan.tool ? 'tool_calls' : 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: usage.in, completion_tokens: usage.out } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Anthropic
    const content = [];
    if (text) content.push({ type: 'text', text });
    if (plan.tool) content.push({ type: 'tool_use', id: callId, name: plan.tool.name, input: plan.tool.args ?? {} });
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content, stop_reason: plan.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: usage.in, output_tokens: usage.out } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { usage: { input_tokens: usage.in, output_tokens: 1 } } });
    let idx = 0;
    if (text) {
      ev('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
      for (const c of chunks(text)) { await wait(); ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: c } }); }
      ev('content_block_stop', { index: idx++ });
    }
    if (plan.tool) {
      ev('content_block_start', { index: idx, content_block: { type: 'tool_use', id: callId, name: plan.tool.name, input: {} } });
      for (const c of chunks(args, 5)) ev('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: c } });
      ev('content_block_stop', { index: idx++ });
    }
    ev('message_delta', { delta: { stop_reason: plan.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: usage.out } });
    ev('message_stop', {});
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/v1`;
      resolve({ url, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 8788;
  startMock({ port, delayMs: 30 }).then((m) => console.log(`Mock model API at ${m.url} (any API key works except one containing "bad-key")`));
}
