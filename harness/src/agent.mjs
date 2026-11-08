// The tool-use loop: call the model, run (or ask about) each tool call, feed
// results back, repeat until the model stops calling tools.
import { callModel } from './providers.mjs';
import { executeTool, READ_ONLY_TOOLS } from './tools.mjs';

// Harness-authored wording; Claude Code's own strings for these are not in the prompt repo.
export const DENIED_RESULT = 'The user declined this tool call, so it was not run. Do not retry the same call. Ask the user how to proceed, or take a different approach.';
export const DRY_RUN_RESULT = 'Tool execution is disabled for this run (dry run). The call was recorded but not executed.';

export const APPROVAL_MODES = {
  'ask-writes': 'Auto-run read-only tools, ask before Bash/Write/Edit',
  ask: 'Ask before every tool call',
  auto: 'Run every tool call automatically',
  never: 'Dry run: never execute tools',
};

/**
 * Wrap an interactive `ask(toolUse)` callback with an approval mode.
 * `ask` resolves to { decision: 'approve' | 'deny' | 'result', result?, is_error?, note? }.
 */
export function approvalPolicy(mode, ask) {
  return async (use) => {
    if (mode === 'auto') return { decision: 'approve' };
    if (mode === 'never') return { decision: 'result', result: DRY_RUN_RESULT, is_error: true };
    if (mode === 'ask-writes' && READ_ONLY_TOOLS.has(use.name)) return { decision: 'approve' };
    return ask ? ask(use) : { decision: 'deny' };
  };
}

/** Close out tool calls left without results (e.g. a stopped run) so the history stays valid. */
export function repairDangling(messages) {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const uses = last.content.filter((b) => b.type === 'tool_use');
    if (uses.length) {
      messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'Interrupted: the run was stopped before this tool call finished.', is_error: true })) });
    }
  }
  return messages;
}

export function sumUsage(turns) {
  const total = { input: 0, output: 0, reasoning: 0, cached: 0, totalMs: 0, calls: turns.length };
  for (const t of turns) {
    for (const k of ['input', 'output', 'reasoning', 'cached']) total[k] += Number(t.usage?.[k]) || 0;
    total.totalMs += t.timing?.totalMs || 0;
  }
  return total;
}

/**
 * Run the agent loop. Mutates and returns `messages` (the full conversation).
 * @param {object} o
 * @param {object} o.provider see callModel
 * @param {string} o.model
 * @param {string} [o.system]
 * @param {object[]} [o.tools] tool definitions ({ name, description, input_schema })
 * @param {object[]} o.messages conversation so far, ending with the new user message
 * @param {object} [o.params] temperature, max_tokens, stream, ...
 * @param {number} [o.maxTurns]
 * @param {(use: object) => Promise<object>} o.approval decision per tool call (see approvalPolicy)
 * @param {object} o.toolCtx from createToolContext()
 * @param {(event: object) => void} [o.onEvent]
 * @param {AbortSignal} [o.signal]
 */
export async function runAgent({ provider, model, system, tools = [], messages, params = {}, maxTurns = 25, approval, toolCtx, onEvent = () => {}, signal }) {
  const turns = [];
  const offered = new Set(tools.map((t) => t.name));
  for (let turn = 1; turn <= maxTurns; turn++) {
    onEvent({ type: 'turn_start', turn });
    const res = await callModel(provider, { model, system, tools, messages, params, signal, onEvent: (e) => onEvent({ ...e, turn }) });
    messages.push(res.message);
    const record = { turn, usage: res.usage, timing: res.timing, stopReason: res.stopReason };
    turns.push(record);
    onEvent({ type: 'turn_end', ...record, message: res.message });

    const uses = res.message.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return { messages, turns, stopped: res.stopReason || 'end_turn' };

    const results = [];
    for (const use of uses) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      let result;
      onEvent({ type: 'tool_pending', turn, id: use.id, name: use.name, input: use.input });
      if (use.input_error) {
        result = { content: `<tool_use_error>${use.input_error}</tool_use_error>`, is_error: true };
      } else if (!offered.has(use.name)) {
        result = { content: `<tool_use_error>No such tool available: ${use.name}</tool_use_error>`, is_error: true };
      } else {
        const d = await approval(use);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (d.decision === 'approve') result = await executeTool(use.name, use.input, toolCtx);
        else if (d.decision === 'result') result = { content: String(d.result ?? ''), is_error: !!d.is_error };
        else result = { content: DENIED_RESULT + (d.note ? `\nThe user said: ${d.note}` : ''), is_error: true };
        result.decision = d.decision;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: result.content, is_error: !!result.is_error });
      onEvent({ type: 'tool_result', turn, id: use.id, name: use.name, content: result.content, is_error: !!result.is_error, decision: result.decision, todos: use.name === 'TodoWrite' ? toolCtx.todos : undefined, cwd: toolCtx.cwd });
    }
    messages.push({ role: 'user', content: results });
  }
  return { messages, turns, stopped: 'max_turns' };
}
