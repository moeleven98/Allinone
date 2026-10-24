// Pre-tool-use guard for the harnesses' own (native) tools, implementing
// PERMISSIONS.md v0.2: let everything through except irreversible commands,
// which must be confirmed by the user in that harness's own prompt.
// The irreversible-command list is the same one the hub uses (config.json).
//
// Lead (normal use):   irreversible shell command -> ask; everything else -> allowed.
// Workers execute ordinary tasks with the same irreversible-command checks as leads.
//
//   node guard.mjs --for claude   (Claude Code PreToolUse hook)
//   node guard.mjs --for agy      (agy PreToolUse hook)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'config.json'), 'utf8'));
const IRREVERSIBLE = CONFIG.irreversibleCommandPatterns.map((p) => ({ why: p.why, re: new RegExp(p.re, 'im') }));
const target = process.argv[process.argv.indexOf('--for') + 1];


function irreversibleReason(command) {
  for (const p of IRREVERSIBLE) if (p.re.test(command || '')) return p.why;
  return null;
}

function decide(input) {
  if (target === 'claude') {
    const why = irreversibleReason(input.tool_input?.command);
    if (why) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `.Allinone 权限协议：这是不可撤销的操作（${why}），需要你确认。` } };
    }
    return null; // defer to the normal permission rules (which allow it)
  }

  if (target === 'agy') {
    const args = input.toolCall?.args || {};
    const why = irreversibleReason(args.CommandLine ?? args.commandLine ?? args.command);
    if (why) return { decision: 'force_ask', reason: `.Allinone 权限协议：这是不可撤销的操作（${why}），需要你确认。` };
    return { decision: 'allow' };
  }

  throw new Error('用法：node guard.mjs --for claude|agy');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw.replace(/^﻿/, '').trim() || '{}'); } catch { /* treat as empty */ }
  const out = decide(input);
  if (out) process.stdout.write(JSON.stringify(out));
});
