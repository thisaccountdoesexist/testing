#!/usr/bin/env node
// Clone or update Piebald-AI/claude-code-system-prompts into harness/vendor/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DEFAULT_PROMPTS_REPO } from '../src/prompts.mjs';

const REPO = process.env.HARNESS_PROMPTS_REPO_URL || 'https://github.com/Piebald-AI/claude-code-system-prompts.git';
const git = (args, opts = {}) => spawnSync('git', args, { stdio: 'inherit', ...opts });

if (fs.existsSync(`${DEFAULT_PROMPTS_REPO}/.git`)) {
  console.log(`Updating ${DEFAULT_PROMPTS_REPO}`);
  const r = git(['-C', DEFAULT_PROMPTS_REPO, 'pull', '--ff-only', '--depth', '1']);
  process.exit(r.status ?? 1);
} else {
  console.log(`Cloning ${REPO} -> ${DEFAULT_PROMPTS_REPO}`);
  const r = git(['clone', '--depth', '1', REPO, DEFAULT_PROMPTS_REPO]);
  if (r.error) console.error('git is required: https://git-scm.com/downloads');
  process.exit(r.status ?? 1);
}
