import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderTemplate } from '../src/template.mjs';
import { PromptLibrary, assemble, loadPresets, parseFragment, renderSections } from '../src/prompts.mjs';
import { createToolContext, executeTool } from '../src/tools.mjs';
import { runAgent, approvalPolicy, repairDangling } from '../src/agent.mjs';
import { callModel, listModels } from '../src/providers.mjs';
import { startMock } from './mock-upstream.mjs';

const scope = (vars) => (name) => vars[name];

test('template: identifiers, calls, arithmetic, ternaries', () => {
  const s = scope({ A: 'x', T: 'Bash', F: () => 'hi', N: 600000, L: ['a', 'b'], O: { k: 'v' } });
  assert.equal(renderTemplate('${A} and ${T}', s).text, 'x and Bash');
  assert.equal(renderTemplate('${F()}!', s).text, 'hi!');
  assert.equal(renderTemplate('${N/60000} min', s).text, '10 min');
  assert.equal(renderTemplate('${A?`yes ${T}`:""}', s).text, 'yes Bash');
  assert.equal(renderTemplate('${L.map((x)=>`<${x}>`).join(", ")}', s).text, '<a>, <b>');
  assert.equal(renderTemplate('${O.k}|${A==="x"?"eq":"ne"}', s).text, 'v|eq');
});

test('template: un-escaped backticks and apostrophes inside nested literals', () => {
  const s = scope({ A: true });
  assert.equal(renderTemplate('${A?`(e.g. `/simplify`, `/batch`)`:""}.', s).text, '(e.g. `/simplify`, `/batch`).');
  assert.equal(renderTemplate("${A?'you'll see it':\"\"}", s).text, "you'll see it");
});

test('template: unresolved names are reported, optionally kept', () => {
  const r = renderTemplate('[${MISSING}][${MISSING_FN(1)}]', scope({}));
  assert.equal(r.text, '[][]');
  assert.deepEqual(r.unresolved.sort(), ['MISSING', 'MISSING_FN']);
  assert.equal(renderTemplate('${MISSING}', scope({}), { keepUnresolved: true }).text, '${MISSING}');
});

test('template: never executes code', () => {
  globalThis.__pwned = false;
  const r = renderTemplate('${globalThis.__pwned=true}${constructor.constructor("globalThis.__pwned=true")()}', scope({}));
  assert.equal(globalThis.__pwned, false);
  assert.ok(typeof r.text === 'string');
});

test('fragment frontmatter parsing', () => {
  const { meta, body } = parseFragment('<!--\nname: "Tool Description: X"\nccVersion: "2.1.1"\nvariables:\n  - "A"\n  - "B"\n-->\nHello ${A}');
  assert.equal(meta.name, 'Tool Description: X');
  assert.deepEqual(meta.variables, ['A', 'B']);
  assert.equal(body, 'Hello ${A}');
});

test('sections: bullets join under headings; per-section vars', () => {
  const lib = { get: (id) => (id === 'f' ? { body: 'Use ${X}' } : undefined) };
  const r = renderSections([{ text: '# Head' }, { file: 'f', bullet: true }, { file: 'f', bullet: true, vars: { X: 'Local' } }, { file: 'nope' }], lib, { scope: scope({ X: 'Global' }) });
  assert.equal(r.text, '# Head\n - Use Global\n - Use Local');
  assert.deepEqual(r.missing, ['nope']);
});

const library = new PromptLibrary().load();
test('presets assemble from the real prompt repo with no unresolved variables', { skip: !library.available && 'run npm run fetch-prompts first' }, () => {
  for (const [id, preset] of Object.entries(loadPresets())) {
    for (const toolStyle of ['compact', 'classic']) {
      const r = assemble(library, { sections: preset.sections, toolNames: preset.tools, toolStyle, ctx: { model: 'm', workspace: '/w' } });
      assert.deepEqual(r.missing, [], `${id}: missing fragments`);
      assert.deepEqual(r.unresolved, [], `${id}/${toolStyle}: unresolved variables`);
      assert.deepEqual(r.errors, [], `${id}: template errors`);
      assert.equal(r.tools.length, preset.tools.length);
      assert.ok(!/\$\{/.test(r.system), `${id}: leftover placeholder`);
    }
  }
});

let ws;
before(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-')); });
after(() => fs.rmSync(ws, { recursive: true, force: true }));

test('tools: confined to workspace, read-before-write, edit uniqueness', async () => {
  const ctx = createToolContext(ws);
  let r = await executeTool('Read', { file_path: '/etc/passwd' }, ctx);
  assert.ok(r.is_error && /outside the harness workspace/.test(r.content));
  r = await executeTool('Write', { file_path: '../escape.txt', content: 'x' }, ctx);
  assert.ok(r.is_error);
  fs.symlinkSync('/etc', path.join(ws, 'link'));
  r = await executeTool('Read', { file_path: 'link/hostname' }, ctx);
  assert.ok(r.is_error && /outside/.test(r.content), 'symlink escape blocked');

  r = await executeTool('Write', { file_path: 'a.txt', content: 'one two two\n' }, ctx);
  assert.ok(!r.is_error && /created/.test(r.content));
  fs.writeFileSync(path.join(ws, 'b.txt'), 'pre-existing');
  r = await executeTool('Write', { file_path: 'b.txt', content: 'new' }, ctx);
  assert.ok(r.is_error && /not been read/.test(r.content));
  r = await executeTool('Edit', { file_path: 'a.txt', old_string: 'two', new_string: '2' }, ctx);
  assert.ok(r.is_error && /Found 2 matches/.test(r.content));
  r = await executeTool('Edit', { file_path: 'a.txt', old_string: 'two', new_string: '2', replace_all: true }, ctx);
  assert.ok(!r.is_error);
  r = await executeTool('Read', { file_path: path.join(ws, 'a.txt') }, ctx);
  assert.equal(r.content, '     1\tone 2 2');
  r = await executeTool('Glob', { pattern: '*.txt' }, ctx);
  assert.match(r.content, /a\.txt/);
  r = await executeTool('Grep', { pattern: 'one', output_mode: 'content' }, ctx);
  assert.ok(r.is_error || /a\.txt:1:one/.test(r.content), r.content);
});

test('tools: bash keeps cwd, resets it when it leaves the workspace, hides secrets', async () => {
  const ctx = createToolContext(ws);
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  await executeTool('Bash', { command: 'cd sub' }, ctx);
  assert.equal(ctx.cwd, path.join(ctx.root, 'sub'));
  await executeTool('Bash', { command: 'cd /' }, ctx);
  assert.equal(ctx.cwd, ctx.root);
  process.env.HARNESS_API_KEY = 'secret-value';
  const r = await executeTool('Bash', { command: 'echo "k=$HARNESS_API_KEY"; exit 3' }, ctx);
  assert.match(r.content, /^k=\nExit code 3/);
  assert.equal(r.is_error, true);
  delete process.env.HARNESS_API_KEY;
});

for (const format of ['openai', 'anthropic']) {
  for (const stream of [true, false]) {
    test(`agent loop end-to-end (${format}, stream=${stream})`, async () => {
      const mock = await startMock();
      try {
        const provider = { baseUrl: mock.url, format, apiKey: 'k' };
        const ctx = createToolContext(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-loop-')));
        const lib = { get: () => undefined };
        const { tools } = assemble(lib, { sections: [], toolNames: ['Bash', 'Write'] });
        const events = [];
        const messages = [{ role: 'user', content: 'please run bash' }];
        const r = await runAgent({ provider, model: 'gemini-4-argon', system: 'sys', tools, messages, params: { stream }, approval: approvalPolicy('auto'), toolCtx: ctx, onEvent: (e) => events.push(e) });
        assert.equal(r.turns.length, 2);
        assert.equal(messages.length, 4);
        const toolResult = messages[2].content[0];
        assert.equal(toolResult.type, 'tool_result');
        assert.match(toolResult.content, /hello-from-bash/);
        assert.match(messages[3].content.find((b) => b.type === 'text').text, /Tool said: hello-from-bash/);
        assert.ok(events.some((e) => e.type === 'tool_result'));
        assert.ok(r.turns[0].usage.input > 0);
        const sent = mock.requests.at(-1).body;
        if (format === 'openai') {
          assert.equal(sent.messages[0].role, 'system');
          assert.equal(sent.messages.at(-1).role, 'tool');
          assert.equal(sent.tools[0].type, 'function');
          assert.equal(mock.requests[0].headers.authorization, 'Bearer k');
        } else {
          assert.equal(sent.system, 'sys');
          assert.equal(sent.messages.at(-1).content[0].type, 'tool_result');
          assert.equal(mock.requests[0].headers['x-api-key'], 'k');
        }
      } finally { await mock.close(); }
    });
  }
}

test('approval: deny and dry run never execute', async () => {
  const mock = await startMock();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-deny-'));
    const ctx = createToolContext(dir);
    const { tools } = assemble({ get: () => undefined }, { sections: [], toolNames: ['Write'] });
    for (const approval of [approvalPolicy('ask', async () => ({ decision: 'deny' })), approvalPolicy('never')]) {
      const messages = [{ role: 'user', content: 'write a file' }];
      await runAgent({ provider: { baseUrl: mock.url, format: 'openai', apiKey: 'k' }, model: 'x', tools, messages, params: {}, approval, toolCtx: ctx });
      assert.equal(messages[2].content[0].is_error, true);
      assert.ok(!fs.existsSync(path.join(dir, 'hello.txt')));
    }
  } finally { await mock.close(); }
});

test('providers: malformed tool JSON becomes an error result; errors are reported', async () => {
  const mock = await startMock();
  try {
    const provider = { baseUrl: mock.url, format: 'openai', apiKey: 'k' };
    const { tools } = assemble({ get: () => undefined }, { sections: [], toolNames: ['Read'] });
    const r = await callModel(provider, { model: 'x', tools, messages: [{ role: 'user', content: 'bad json' }], params: { stream: true } });
    assert.match(r.message.content.find((b) => b.type === 'tool_use').input_error, /not valid JSON/);
    await assert.rejects(callModel({ ...provider, apiKey: 'bad-key-123' }, { model: 'x', messages: [{ role: 'user', content: 'hi' }] }), /HTTP 401/);
    await assert.rejects(callModel({ ...provider, retries: 0 }, { model: 'mock-error', messages: [{ role: 'user', content: 'hi' }] }), /HTTP 500/);
    assert.deepEqual(await listModels(provider), ['gemini-4-argon', 'mock-large', 'mock-small']);
  } finally { await mock.close(); }
});

test('repairDangling closes unanswered tool calls', () => {
  const m = [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }];
  repairDangling(m);
  assert.equal(m.length, 3);
  assert.equal(m[2].content[0].tool_use_id, 't1');
});
