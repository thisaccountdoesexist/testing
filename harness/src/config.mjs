// Settings from harness/.env and the process environment (environment wins).
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_DIR } from './prompts.mjs';

export function loadDotEnv(file = path.join(HARNESS_DIR, '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

export function loadConfig(env = { ...loadDotEnv(), ...process.env }) {
  return {
    host: env.HARNESS_HOST || '127.0.0.1',
    port: Number(env.HARNESS_PORT) || 8787,
    baseUrl: env.HARNESS_BASE_URL || 'https://apinex.bond/v1',
    format: env.HARNESS_API_FORMAT === 'anthropic' ? 'anthropic' : 'openai',
    authHeader: env.HARNESS_AUTH_HEADER || 'auto',
    apiKey: env.HARNESS_API_KEY || '',
    model: env.HARNESS_MODEL || 'gemini-4-argon',
    workspace: path.resolve(HARNESS_DIR, env.HARNESS_WORKSPACE || 'workspace'),
    runsDir: path.resolve(HARNESS_DIR, env.HARNESS_RUNS_DIR || 'runs'),
    promptsRepo: env.HARNESS_PROMPTS_DIR ? path.resolve(env.HARNESS_PROMPTS_DIR) : undefined,
  };
}
