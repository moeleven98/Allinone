// .Allinone dispatch hub: a zero-dependency MCP server over stdio.
//
// Every harness (Claude Code, Codex, agy, dsh) registers this file in its own
// home folder. Whichever harness the user opened is the lead; through these
// tools it can read and change files (with a trash backup, so changes can be
// undone), run commands, and dispatch sub-tasks to the other agents' CLIs.
// Only irreversible actions stop for the user's approval, shown as a Windows
// dialog by this process (see protocol\PERMISSIONS.md, v0.2).
//
// Environment:
//   AIO_AGENT          which harness started this hub (claude|codex|gemini|deepseek)
//   AIO_HUB_WORKER=1   started inside a dispatched worker: read-only tool set
//   AIO_HUB_APPROVAL   dialog (default) | approve | deny   (the last two are for tests)
//   AIO_HUB_BOARD      board folder override (tests only)

import fs from 'node:fs';
import { codexRateLimits, claudeUsage } from './quota-live.mjs';
import { imageRequest, reserveImageRequest } from './image-policy.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(HUB_DIR, '..', '..');
const BOARD = process.env.AIO_HUB_BOARD || path.join(MCP_DIR, 'board'); // override only for self-tests
const TRASH = path.join(BOARD, 'trash');
const CONFIG = JSON.parse(fs.readFileSync(process.env.AIO_HUB_CONFIG || path.join(HUB_DIR, 'config.json'), 'utf8'));
const PROJECTS_DIR = process.env.AIO_HUB_PROJECTS || path.join(MCP_DIR, 'projects');

// Every project under MCP\projects gets its own board (board\projects\<name>\), so two
// leads working on two projects never share or read each other's records. Only the
// things that are global by nature stay in board\: daily spend, quota cache, trash,
// and the pick history used for fair tie-breaks.
const GLOBAL_LOGS = new Set(['spend.jsonl', 'picks.jsonl', 'hub-starts.jsonl']);

function projectOf(dir) {
  const rel = path.relative(PROJECTS_DIR, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '_root';
  return rel.split(path.sep)[0];
}
const DEFAULT_PROJECT = process.env.AIO_PROJECT || projectOf(process.cwd());

function cleanProject(name) {
  const p = String(name || DEFAULT_PROJECT).trim();
  if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(p) || p === '.' || p === '..') throw new Error(`项目名不合法：${p}`);
  return p;
}
const boardDir = (project) => path.join(BOARD, 'projects', cleanProject(project));
const CALLER = process.env.AIO_AGENT || 'unknown';
const IS_WORKER = process.env.AIO_HUB_WORKER === '1';
const APPROVAL_MODE = process.env.AIO_HUB_APPROVAL || 'dialog';
const VERSION = '0.2.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SENSITIVE = CONFIG.sensitivePathPatterns.map((s) => new RegExp(s, 'i'));
const IRREVERSIBLE = CONFIG.irreversibleCommandPatterns.map((p) => ({ why: p.why, re: new RegExp(p.re, 'im') }));

// ---------------------------------------------------------------- helpers

const now = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE');

function expand(value, vars) {
  return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function resolvePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('缺少路径参数');
  return path.resolve(process.cwd(), p.replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE || '~'));
}

function logPath(name, project) {
  return GLOBAL_LOGS.has(name) ? path.join(BOARD, name) : path.join(boardDir(project), name);
}

function appendLog(name, record, project) {
  const file = logPath(name, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ time: now(), caller: CALLER, pid: process.pid, project: cleanProject(project), ...record }) + '\n';
  fs.appendFileSync(file, line, 'utf8');
}

function readLogTail(name, limit, project) {
  const file = logPath(name, project);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

function truncate(text, max = 50000) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（已截断，原长 ${text.length} 字符）`;
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

async function sizeOf(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fsp.readdir(p, { withFileTypes: true })) total += await sizeOf(path.join(p, e.name));
  return total;
}

// rename, falling back to copy + remove when crossing drives
async function moveAny(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(from, to, { recursive: true, preserveTimestamps: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- approval

function showDialog(title, message) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    "$r = [System.Windows.Forms.MessageBox]::Show($owner, $env:AIO_DIALOG_MESSAGE, $env:AIO_DIALOG_TITLE, 'YesNo', 'Warning', 'Button2')",
    "if ($r -eq 'Yes') { exit 0 } else { exit 1 }",
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, AIO_DIALOG_TITLE: title, AIO_DIALOG_MESSAGE: message },
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, CONFIG.approvalTimeoutSec * 1000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// Ask the user about one irreversible action. Returns true only on an explicit "Yes".
async function requestApproval({ category, action, detail, project }) {
  const id = crypto.randomUUID();
  const message = [
    `发起方：${CALLER}`,
    `类别：${category}（这类操作做了就撤不回来）`,
    '',
    `要做的事：${action}`,
    detail ? `\n${truncate(detail, 1500)}` : '',
    '',
    '点“是”执行，点“否”取消。',
  ].join('\n');
  let approved;
  if (APPROVAL_MODE === 'approve') approved = true;
  else if (APPROVAL_MODE === 'deny') approved = false;
  else approved = await showDialog('.Allinone 调度中心 · 需要你批准', message);
  appendLog('approvals.jsonl', { id, category, action, detail: truncate(detail || '', 4000), approved, mode: APPROVAL_MODE }, project);
  return approved;
}

function denied(category) {
  return `用户没有批准（${category}），操作已取消。`;
}

// ---------------------------------------------------------------- trash

// Move (or copy) an existing path into the trash and return the entry id.
async function toTrash(target, reason, { copy = false } = {}) {
  const id = `${today()}_${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(TRASH, today(), id);
  const item = path.join(dir, 'item');
  await fsp.mkdir(dir, { recursive: true });
  if (copy) await fsp.cp(target, item, { recursive: true, preserveTimestamps: true });
  else await moveAny(target, item);
  const meta = { id, originalPath: target, reason, time: now(), caller: CALLER, project: DEFAULT_PROJECT };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return id;
}

async function listTrash() {
  const out = [];
  if (!fs.existsSync(TRASH)) return out;
  for (const day of await fsp.readdir(TRASH)) {
    const dayDir = path.join(TRASH, day);
    if (!(await fsp.stat(dayDir)).isDirectory()) continue;
    for (const id of await fsp.readdir(dayDir)) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(dayDir, id, 'meta.json'), 'utf8'))); } catch { /* skip broken entry */ }
    }
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

function trashEntryDir(id) {
  if (!/^\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/.test(id)) throw new Error('回收站编号格式不对');
  return path.join(TRASH, id.slice(0, 10), id);
}

// ---------------------------------------------------------------- process runner

function runProcess(command, args, { cwd, env, timeoutSec, stdin }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr, seconds: Math.round((Date.now() - started) / 100) / 10 });
    });
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  });
}

function classifyCommand(command) {
  for (const p of IRREVERSIBLE) if (p.re.test(command)) return p.why;
  return null;
}

// ---------------------------------------------------------------- dispatch

function agentEnv(agent, vars) {
  const env = { ...process.env, AIO_HUB_WORKER: '1', AIO_AGENT: agent.name };
  for (const [k, v] of Object.entries(agent.env || {})) {
    if (v === '') delete env[k];
    else env[k] = expand(v, { ...vars, PATH: process.env.PATH || '' });
  }
  for (const [k, file] of Object.entries(agent.secretEnvFiles || {})) {
    const f = expand(file, vars);
    if (fs.existsSync(f)) env[k] = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim();
  }
  return env;
}

function jsonLines(text) {
  return text.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function firstJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { /* fall through */ }
  for (const l of text.split(/\r?\n/)) { try { return JSON.parse(l); } catch { /* next */ } }
  return null;
}

const PARSERS = {
  codex(out) {
    const ev = jsonLines(out);
    const msgs = ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text);
    return {
      text: msgs.at(-1) ?? '',
      sessionId: ev.find((e) => e.type === 'thread.started')?.thread_id,
      usage: ev.filter((e) => e.type === 'turn.completed').at(-1)?.usage,
      resume: (id) => `codex exec resume ${id} "<继续的内容>"`,
    };
  },
  claude(out) {
    const j = firstJson(out) || {};
    return { text: j.result ?? '', sessionId: j.session_id, usage: j.usage, isError: j.is_error, resume: (id) => `claude -p "<继续的内容>" --resume ${id}` };
  },
  gemini(out) {
    const j = firstJson(out) || {};
    return { text: j.response ?? '', sessionId: j.conversation_id, usage: j.usage, isError: j.status && j.status !== 'SUCCESS', resume: (id) => `agy -p "<继续的内容>" --conversation ${id}` };
  },
  deepseek(out) {
    const ev = jsonLines(out);
    const usage = ev.filter((e) => e.type === 'status' && e.usage).map((e) => e.usage)
      .reduce((a, u) => { for (const [k, v] of Object.entries(u)) a[k] = (a[k] || 0) + (Number(v) || 0); return a; }, {});
    return {
      text: ev.filter((e) => e.type === 'final').at(-1)?.text ?? '',
      sessionId: ev.find((e) => e.type === 'session')?.sessionId,
      usage,
      resume: (id) => `dsh headless --session-id ${id} "<继续的内容>"`,
    };
  },
};

async function deepseekBalance() {
  const keyFile = path.join(MCP_DIR, 'agents', 'deepseek', 'home', 'deepseek-api-key.txt');
  if (!fs.existsSync(keyFile)) return { ok: false, note: '没有找到 DeepSeek 密钥文件' };
  const key = fs.readFileSync(keyFile, 'utf8').replace(/^﻿/, '').trim();
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const info = (j.balance_infos || []).find((b) => b.currency === 'CNY') || (j.balance_infos || [])[0];
    return { ok: r.ok, available: j.is_available, balance: info ? Number(info.total_balance) : null, currency: info?.currency };
  } catch (e) {
    return { ok: false, note: `查询失败：${e.message}` };
  }
}

function spentToday() {
  return readLogTail('spend.jsonl', 10000).filter((r) => r.date === today()).reduce((s, r) => s + (Number(r.cny) || 0), 0);
}

// ---------------------------------------------------------------- quotas & routing (protocol\ROUTING.md)

const ROUTING = CONFIG.routing;
const QUOTA_CACHE = path.join(BOARD, 'quota-cache.json');
// .Allinone sits directly in the real user folder; derive it from there because some
// harnesses (agy) run with USERPROFILE redirected into their own home.

function readQuotaCache() {
  try { return JSON.parse(fs.readFileSync(QUOTA_CACHE, 'utf8')); } catch { return {}; }
}
function writeQuotaCache(cache) {
  fs.mkdirSync(BOARD, { recursive: true });
  fs.writeFileSync(QUOTA_CACHE, JSON.stringify(cache, null, 2), 'utf8');
}

// A window whose reset time has passed is full again.
function remainingOf(usedPercent, resetsAtMs) {
  if (resetsAtMs && resetsAtMs <= Date.now()) return 100;
  return Math.max(0, Math.round(100 - Number(usedPercent)));
}

async function codexQuota() {
  const agent = CONFIG.agents.codex;
  const vars = { MCP: MCP_DIR, cwd: PROJECTS_DIR };
  const data = await codexRateLimits(expand(agent.command, vars), agentEnv({ ...agent, name: 'codex' }, vars), PROJECTS_DIR);
  const rl = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
  if (!rl) throw new Error('Codex 没有返回额度窗口');
  const windows = ['primary', 'secondary'].filter((k) => rl[k]).map((k) => ({
    name: rl[k].windowDurationMins >= 10000 ? '每周' : `${Math.round(rl[k].windowDurationMins / 60)} 小时`,
    remaining: remainingOf(rl[k].usedPercent, rl[k].resetsAt * 1000),
    resetsAt: new Date(rl[k].resetsAt * 1000).toISOString(),
  }));
  return { fetchedAt: now(), windows, source: 'Codex account/rateLimits/read 实时接口' };
}

async function claudeQuota() {
  const home = expand(CONFIG.agents.claude.env.CLAUDE_CONFIG_DIR, { MCP: MCP_DIR });
  const usage = await claudeUsage(home);
  const names = { five_hour: '5 小时', seven_day: '每周' };
  const windows = Object.entries(usage).filter(([k, v]) => names[k] && v).map(([k, v]) => ({
    name: names[k], remaining: remainingOf(v.utilization, Date.parse(v.resets_at)), resetsAt: v.resets_at,
  }));
  return { fetchedAt: now(), windows, source: 'Claude 订阅额度实时接口' };
}

async function geminiQuota() {
  const g = CONFIG.agents.gemini;
  const vars = { MCP: MCP_DIR, cwd: path.join(MCP_DIR, 'projects'), task: '/usage', timeoutSec: 60 };
  const r = await runProcess(expand(g.command, vars), ['-p', '/usage', '--output-format', 'json', '--print-timeout', '60s'], { cwd: vars.cwd, env: agentEnv({ ...g, name: 'gemini' }, vars), timeoutSec: 90 });
  const groups = firstJson(r.stdout)?.command?.data?.groups;
  if (!groups) throw new Error('agy /usage 没有返回额度');
  // agy's default model is Gemini 4 Argon, which draws on both the Gemini group and its own Argon bucket.
  const windows = groups.filter((grp) => /gemini/i.test(grp.name)).flatMap((grp) => grp.buckets.map((b) => ({
    name: `${grp.name} · ${b.window === '5h' ? '5 小时' : b.window === 'weekly' ? '每周' : b.window}`,
    remaining: remainingOf(100 - b.remaining_fraction * 100, Date.parse(b.reset_time)), resetsAt: b.reset_time,
  })));
  const result = { fetchedAt: now(), windows, source: 'agy /usage' };
  writeQuotaCache({ ...readQuotaCache(), gemini: result });
  return result;
}

async function deepseekQuota() {
  const bal = await deepseekBalance();
  if (!bal.ok) throw new Error(bal.note || 'DeepSeek 余额查询失败');
  const left = CONFIG.budgetCnyPerDay - spentToday();
  return { fetchedAt: now(), balance: bal.balance, available: bal.available, budgetLeft: left, source: 'DeepSeek 余额接口' };
}

// Normalized view: { agent: { status: ok|low|unknown, remaining, detail } }
async function readQuotas() {
  if (process.env.AIO_HUB_QUOTA_FIXTURE) return JSON.parse(fs.readFileSync(process.env.AIO_HUB_QUOTA_FIXTURE, 'utf8'));
  const marks = readQuotaCache().lowMarks || {};
  const out = {};
  const checkedAt = now();
  const names = ['codex', 'claude', 'gemini', 'deepseek'];
  const results = await Promise.allSettled([codexQuota(), claudeQuota(), geminiQuota(), deepseekQuota()]);
  const raw = Object.fromEntries(names.map((name, i) => [name, results[i].status === 'fulfilled' ? results[i].value : null]));
  for (let i = 0; i < names.length; i++) {
    if (results[i].status === 'rejected') out[names[i]] = {
      status: 'unknown', remaining: null, checkedAt, detail: '本次实时查询失败（未使用旧缓存）',
    };
  }
  for (const [name, q] of Object.entries(raw)) {
    if (!q) { out[name] ||= { status: 'unknown', remaining: null, checkedAt, detail: '本次没有返回额度' }; continue; }
    if (name === 'deepseek') {
      const ok = q.available !== false && q.balance > 0;
      out[name] = { status: ok ? 'ok' : 'low', remaining: null, detail: `余额 ${q.balance} 元，今日预算剩 ${q.budgetLeft.toFixed(2)} 元`, fetchedAt: q.fetchedAt, checkedAt, source: q.source };
      continue;
    }
    const stale = Date.now() - Date.parse(q.fetchedAt) > ROUTING.staleAfterHours * 3600000;
    const remaining = q.windows.length ? Math.min(...q.windows.map((w) => w.remaining)) : null;
    const mark = marks[name] && Date.parse(marks[name].until) > Date.now() ? marks[name] : null;
    let status = stale || remaining == null ? 'unknown' : remaining < ROUTING.lowQuotaPercent ? 'low' : 'ok';
    if (mark) status = 'low';
    out[name] = {
      status, remaining,
      detail: [q.windows.map((w) => `${w.name}剩 ${w.remaining}%`).join('，'), stale ? '（数据已过时）' : '', mark ? `（刚报过额度不足：${mark.reason}）` : ''].join(''),
      fetchedAt: q.fetchedAt, checkedAt, source: q.source,
    };
  }
  return out;
}

// After an agent reports a quota error, treat it as low until its shortest window could have reset.
function markLow(name, reason) {
  const cache = readQuotaCache();
  cache.lowMarks = { ...(cache.lowMarks || {}), [name]: { reason: truncate(reason, 200), until: new Date(Date.now() + 3600000).toISOString() } };
  writeQuotaCache(cache);
}

// Pick an agent for a category: tiers in order; inside a tier the most remaining quota wins;
// unknown quota ranks after known; low quota is skipped; the paid last resort comes last.
function route(category, quotas, exclude = []) {
  const cat = ROUTING.categories[category];
  if (!cat) throw new Error(`不认识的类别：${category}。可选：${Object.keys(ROUTING.categories).join('、')}`);
  const considered = [];
  for (const tier of cat.tiers) {
    const usable = tier.filter((a) => !exclude.includes(a)).map((a) => ({ agent: a, q: quotas[a] || { status: 'unknown' } }))
      .filter((c) => c.q.status !== 'low');
    considered.push(...tier.map((a) => `${a}=${exclude.includes(a) ? '已试过' : quotas[a]?.status ?? 'unknown'}${quotas[a]?.remaining != null ? `(${quotas[a].remaining}%)` : ''}`));
    if (!usable.length) continue;
    // Exact ties must not favour whoever is listed first in the tier (ROUTING.md §0):
    // the agent picked least recently goes first.
    const lastPicked = Object.fromEntries(readLogTail('picks.jsonl', 500).map((r) => [r.picked, Date.parse(r.time)]));
    usable.sort((x, y) => (x.q.status === 'ok' ? 0 : 1) - (y.q.status === 'ok' ? 0 : 1)
      || (y.q.remaining ?? -1) - (x.q.remaining ?? -1)
      || (lastPicked[x.agent] ?? 0) - (lastPicked[y.agent] ?? 0));
    const pick = usable[0];
    return { agent: pick.agent, reason: `“${cat.label}”第 ${cat.tiers.indexOf(tier) + 1} 梯队里剩余额度最多`, considered };
  }
  if (cat.lastResort && !exclude.includes(cat.lastResort) && quotas[cat.lastResort]?.status !== 'low') {
    return { agent: cat.lastResort, reason: '订阅额度都不足，由按量付费的 DeepSeek 顶班', considered };
  }
  return { agent: null, reason: `“${cat.label}”没有可用的 agent`, considered };
}

async function dispatchAuto({ category, task, cwd, timeoutSec, project }, initialQuotas) {
  const cat = category || 'general';
  const tried = [];
  let quotas = initialQuotas;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = route(cat, quotas, tried);
    appendLog('routing.jsonl', { category: cat, attempt, picked: r.agent, reason: r.reason, considered: r.considered }, project);
    if (!r.agent) return `没能派出：${r.reason}。候选：${r.considered.join('，')}`;
    appendLog('picks.jsonl', { picked: r.agent });
    tried.push(r.agent);
    const result = await dispatchTo({ agent: r.agent, task, cwd, timeoutSec, project, routedAs: `${cat}：${r.reason}` });
    if (!result.failed || !new RegExp(ROUTING.quotaErrorPattern, 'i').test(result.errorText)) return result.text;
    markLow(r.agent, result.errorText.split('\n').find((l) => new RegExp(ROUTING.quotaErrorPattern, 'i').test(l)) || '额度不足');
    quotas = await readQuotas();
  }
  return `已换过一次人仍然失败（试过：${tried.join('、')}）。详情见看板 dispatches 记录。`;
}

async function dispatch(args) {
  if (!args.task || !String(args.task).trim()) throw new Error('task 不能为空');
  if (args.agent && args.agent !== 'auto' && !CONFIG.agents[args.agent]) throw new Error(`不认识的 agent：${args.agent}`);
  if ((!args.agent || args.agent === 'auto') && !ROUTING.categories[args.category || 'general']) throw new Error('不认识的 category');
  const count = imageRequest(args);
  if (count !== null) {
    const gate = await reserveImageRequest(BOARD, count);
    if (gate.requiresApproval) {
      const ok = await requestApproval({ category: '批量生图', action: `申请生成 ${count} 张图片`, project: args.project,
        detail: `本次 ${count} 张；滚动一分钟内 ${gate.requestsInMinute} 次生图申请。超过 5 张或 5 次需审核。` });
      if (!ok) return denied('批量生图');
    }
    args = { ...args, task: `${args.task}\n本次生图总量：${count} 张。仅执行这一批；新增生图请求须交回领队 dispatch，不能自行扩大批次。` };
  }
  const checkedAt = now();
  const quotas = await readQuotas();
  const id = crypto.randomUUID();
  appendLog('quota-reads.jsonl', { id, checkedAt, reason: 'dispatch', quotas }, args.project);
  const result = !args.agent || args.agent === 'auto' ? await dispatchAuto(args, quotas) : (await dispatchTo(args)).text;
  return `${result}\n额度：本次已查询全家 · ${checkedAt} · 查询编号 ${id}`;
}

// The worker's full answer goes into a receipt file on the project's board. The lead only
// gets a few lines back (status, receipt path, a short preview), so long answers never
// enter the lead's context; the lead passes the path on to the user.
function writeReceipt(project, rec) {
  const dir = path.join(boardDir(project), 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const id = `${new Date().toLocaleString('sv-SE').replace(/[-: ]/g, '').slice(0, 14)}-${rec.agent}-${crypto.randomUUID().slice(0, 4)}`;
  const file = path.join(dir, `${id}.md`);
  const body = [
    `# 回执 ${id}`,
    '',
    `- 项目：${cleanProject(project)}`,
    `- 派给：${rec.label}${rec.routedAs ? `（自动选人：${rec.routedAs}）` : ''}`,
    `- 结果：${rec.ok ? '完成' : '没有正常完成'} · 用时 ${rec.seconds} 秒 · 退出码 ${rec.exitCode}${rec.timedOut ? ' · 超时被终止' : ''}`,
    rec.sessionId ? `- 会话：${rec.sessionId}（接着聊：\`${rec.resume}\`）` : '',
    rec.usage ? `- 用量：\`${JSON.stringify(rec.usage)}\`` : '',
    rec.spend != null ? `- 花费：${rec.spend} 元` : '',
    `- 工作目录：${rec.cwd}`,
    '',
    '## 任务',
    '',
    rec.task,
    '',
    '## 回复',
    '',
    rec.text || '（没有拿到回复正文）',
    rec.ok ? '' : `\n## 错误输出（末尾）\n\n\`\`\`\n${rec.stderrTail || '（空）'}\n\`\`\``,
  ].filter((l) => l !== '').join('\n').replace(/\n## /g, '\n\n## ');
  fs.writeFileSync(file, body + '\n', 'utf8');
  return { id, file };
}

async function dispatchTo({ agent: name, task, cwd, timeoutSec, project, routedAs }) {
  const agent = CONFIG.agents[name];
  if (!agent) throw new Error(`不认识的 agent：${name}。可选：auto、${Object.keys(CONFIG.agents).join('、')}`);
  if (!task || !String(task).trim()) throw new Error('task 不能为空');
  const proj = cleanProject(project);
  const projDir = path.join(PROJECTS_DIR, proj);
  const workDir = resolvePath(cwd || (proj !== '_root' && fs.existsSync(projDir) ? projDir : PROJECTS_DIR));
  const timeout = Number(timeoutSec) || CONFIG.defaultDispatchTimeoutSec;
  const vars = { MCP: MCP_DIR, cwd: workDir, task: `${String(task)}\n\nAIO 队员执行规则：你是队员，直接完成任务，不再派发、不跑环境体检、不读安装手册。用户已授权本次普通执行和生成服务调用，按任务实际执行并保存成果；仍遵守宿主安全规则及不可撤销操作边界。`, timeoutSec: timeout };

  let balanceBefore = null;
  if (agent.paid) {
    const spent = spentToday();
    if (spent >= CONFIG.budgetCnyPerDay) {
      const ok = await requestApproval({ category: '花钱（超出每日预算）', action: `派活给 ${agent.label}`, detail: `今天已花 ${spent.toFixed(2)} 元，预算 ${CONFIG.budgetCnyPerDay} 元。\n任务：${task}` });
      if (!ok) return { text: denied('超出每日预算'), failed: true, errorText: '' };
    }
    balanceBefore = await deepseekBalance();
  }

  const run = await runProcess(expand(agent.command, vars), agent.args.map((a) => expand(a, vars)), {
    cwd: workDir, env: agentEnv({ ...agent, name }, vars), timeoutSec: timeout,
  });
  const parsed = (PARSERS[agent.parser] || (() => ({ text: '' })))(run.stdout);

  let spend;
  if (agent.paid && balanceBefore?.ok && balanceBefore.balance != null) {
    const after = await deepseekBalance();
    if (after.ok && after.balance != null) {
      spend = Math.max(0, Math.round((balanceBefore.balance - after.balance) * 10000) / 10000);
      appendLog('spend.jsonl', { date: today(), agent: name, cny: spend, balanceAfter: after.balance }, proj);
    }
  }

  const ok = run.code === 0 && !run.timedOut && !parsed.isError && parsed.text !== '';
  const stderrTail = truncate(run.stderr.trim().split('\n').slice(-30).join('\n'), 4000);
  const receipt = writeReceipt(proj, {
    agent: name, label: agent.label, routedAs, ok, exitCode: run.code, timedOut: run.timedOut, seconds: run.seconds,
    sessionId: parsed.sessionId, resume: parsed.sessionId ? parsed.resume?.(parsed.sessionId) : null, usage: parsed.usage,
    spend, cwd: workDir, task: String(task), text: parsed.text, stderrTail,
  });
  appendLog('dispatches.jsonl', {
    receipt: receipt.id, agent: name, ok, exitCode: run.code, timedOut: run.timedOut, seconds: run.seconds, cwd: workDir,
    task: truncate(String(task), 300), sessionId: parsed.sessionId, usage: parsed.usage, spendCny: spend,
  }, proj);

  const preview = (parsed.text || '').replace(/\s+/g, ' ').trim();
  const n = ROUTING.receiptPreviewChars ?? 200;
  const text = [
    `回执 ${receipt.id}：${agent.label} ${ok ? '完成' : '没有正常完成'}，${run.seconds} 秒${routedAs ? `（自动选人：${routedAs}）` : ''}`,
    `全文：${receipt.file}`,
    preview ? `预览：${preview.slice(0, n)}${preview.length > n ? '…' : ''}` : '',
    ok ? '' : `错误：${(stderrTail.split('\n').filter(Boolean).at(-1) || '（空）').slice(0, 200)}`,
  ].filter(Boolean).join('\n');
  return { text, failed: !ok, errorText: ok ? '' : `${run.stderr}\n${parsed.text || run.stdout.slice(-4000)}` };
}

// ---------------------------------------------------------------- tools

const TOOLS = {
  fs_read: {
    readOnly: true,
    description: '读取一个文本文件。可读本机任何位置；只有登录凭证、密钥这类敏感文件需要用户批准。',
    schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: '从第几行开始（1 起）' }, limit: { type: 'integer', description: '最多读多少行' } }, required: ['path'] },
    async run({ path: p, offset, limit }) {
      const file = resolvePath(p);
      if (SENSITIVE.some((re) => re.test(file))) {
        const ok = await requestApproval({ category: '泄露风险', action: `读取敏感文件 ${file}`, detail: '内容会被发送给云端模型，发出去就收不回来。' });
        if (!ok) return denied('泄露风险');
      }
      const st = await fsp.stat(file);
      if (st.isDirectory()) throw new Error('这是文件夹，请用 fs_list');
      if (st.size > CONFIG.maxReadBytes && !offset && !limit) throw new Error(`文件有 ${st.size} 字节，太大；请用 offset/limit 分段读`);
      const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
      const start = Math.max(1, Number(offset) || 1);
      const end = limit ? start - 1 + Number(limit) : lines.length;
      appendLog('actions.jsonl', { tool: 'fs_read', path: file });
      return truncate(lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n'));
    },
  },

  fs_list: {
    readOnly: true,
    description: '列出文件夹内容（名称、类型、大小、修改时间）。',
    schema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', description: '层数，默认 1，最多 3' } }, required: ['path'] },
    async run({ path: p, depth }) {
      const root = resolvePath(p);
      const max = Math.min(3, Math.max(1, Number(depth) || 1));
      const out = [];
      async function walk(dir, level) {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          if (out.length >= 500) return;
          const full = path.join(dir, e.name);
          let st; try { st = await fsp.lstat(full); } catch { continue; }
          out.push(`${e.isDirectory() ? 'D' : 'F'}  ${st.mtime.toISOString().slice(0, 16)}  ${e.isDirectory() ? '' : st.size + 'B  '}${path.relative(root, full)}`);
          if (e.isDirectory() && level < max) await walk(full, level + 1);
        }
      }
      await walk(root, 1);
      return out.length ? out.join('\n') + (out.length >= 500 ? '\n…（最多列 500 项）' : '') : '（空文件夹）';
    },
  },

  fs_search: {
    readOnly: true,
    description: '在文件夹里按文件名和/或内容搜索（跳过 node_modules 和 .git）。',
    schema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string', description: '文件名包含的文字' }, pattern: { type: 'string', description: '内容要匹配的正则表达式' } }, required: ['path'] },
    async run({ path: p, name, pattern }) {
      const root = resolvePath(p);
      const re = pattern ? new RegExp(pattern, 'i') : null;
      const hits = [];
      async function walk(dir) {
        let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length >= 200) return;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { await walk(full); continue; }
          if (name && !e.name.toLowerCase().includes(name.toLowerCase())) continue;
          if (!re) { hits.push(full); continue; }
          let st; try { st = await fsp.stat(full); } catch { continue; }
          if (st.size > 1048576 || SENSITIVE.some((s) => s.test(full))) continue;
          const lines = (await fsp.readFile(full, 'utf8').catch(() => '')).split(/\r?\n/);
          lines.forEach((l, i) => { if (hits.length < 200 && re.test(l)) hits.push(`${full}:${i + 1}: ${l.trim().slice(0, 200)}`); });
        }
      }
      await walk(root);
      return hits.length ? hits.join('\n') + (hits.length >= 200 ? '\n…（最多 200 条）' : '') : '没有找到';
    },
  },

  fs_write: {
    description: '写文件（新建、覆盖或追加）。覆盖或追加已有文件前，原文件会自动备份到回收站，可用 trash_restore 还原。不需要用户批准。',
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
    async run({ path: p, content, append }) {
      const file = resolvePath(p);
      let backup = null;
      if (await exists(file)) backup = await toTrash(file, append ? '追加前备份' : '覆盖前备份', { copy: true });
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (append) await fsp.appendFile(file, content, 'utf8'); else await fsp.writeFile(file, content, 'utf8');
      appendLog('actions.jsonl', { tool: 'fs_write', path: file, append: !!append, bytes: Buffer.byteLength(content), backup });
      return backup ? `已写入 ${file}。原文件已备份到回收站，编号 ${backup}。` : `已新建 ${file}。`;
    },
  },

  fs_move: {
    description: '移动或重命名文件/文件夹。如果目标已存在，目标会先移到回收站。不需要用户批准。',
    schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    async run({ from, to }) {
      const src = resolvePath(from);
      const dst = resolvePath(to);
      if (!(await exists(src))) throw new Error(`不存在：${src}`);
      let backup = null;
      if (await exists(dst)) backup = await toTrash(dst, `被 ${src} 移动覆盖前备份`);
      await moveAny(src, dst);
      appendLog('actions.jsonl', { tool: 'fs_move', from: src, to: dst, backup });
      return `已移动 ${src} → ${dst}${backup ? `。原目标已进回收站，编号 ${backup}` : ''}。要撤销，把它移回原处即可。`;
    },
  },

  fs_delete: {
    description: '删除文件或文件夹：移到回收站（保留 30 天，可还原），不需要批准。只有大到回收站放不下、必须永久删除时才请用户批准。',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run({ path: p }) {
      const target = resolvePath(p);
      if (!(await exists(target))) throw new Error(`不存在：${target}`);
      const bytes = await sizeOf(target);
      if (bytes > CONFIG.maxTrashBytes) {
        const ok = await requestApproval({ category: '永久删除', action: `永久删除 ${target}`, detail: `大小 ${(bytes / 1073741824).toFixed(2)} GB，超过回收站上限，删除后无法还原。` });
        if (!ok) return denied('永久删除');
        await fsp.rm(target, { recursive: true, force: true });
        appendLog('actions.jsonl', { tool: 'fs_delete', path: target, bytes, permanent: true });
        return `已永久删除 ${target}。`;
      }
      const id = await toTrash(target, '删除');
      appendLog('actions.jsonl', { tool: 'fs_delete', path: target, bytes, trash: id });
      return `已移到回收站，编号 ${id}。可用 trash_restore 还原。`;
    },
  },

  trash_list: {
    readOnly: true,
    description: '列出回收站里的条目（最近的在前）。',
    schema: { type: 'object', properties: { limit: { type: 'integer' } } },
    async run({ limit }) {
      const items = (await listTrash()).slice(0, Number(limit) || 30);
      return items.length ? items.map((m) => `${m.id}  ${m.time.slice(0, 16)}  ${m.reason}  ${m.originalPath}  （${m.caller}）`).join('\n') : '回收站是空的';
    },
  },

  trash_restore: {
    description: '把回收站里的条目还原到原位置。原位置现在有东西的话，现有的会先进回收站。',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) {
      const dir = trashEntryDir(id);
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
      let backup = null;
      if (await exists(meta.originalPath)) backup = await toTrash(meta.originalPath, `还原 ${id} 前备份`);
      await moveAny(path.join(dir, 'item'), meta.originalPath);
      await fsp.rm(dir, { recursive: true, force: true });
      appendLog('actions.jsonl', { tool: 'trash_restore', id, path: meta.originalPath, backup });
      return `已还原到 ${meta.originalPath}${backup ? `；原位置的现有内容已进回收站，编号 ${backup}` : ''}。`;
    },
  },

  trash_purge: {
    description: '永久清空回收站里超过指定天数的条目（默认 30 天）。永久删除，需要用户批准。',
    schema: { type: 'object', properties: { olderThanDays: { type: 'integer' } } },
    async run({ olderThanDays }) {
      const days = Number(olderThanDays ?? CONFIG.trashRetentionDays);
      const cutoff = Date.now() - days * 86400000;
      const old = (await listTrash()).filter((m) => Date.parse(m.time) < cutoff);
      if (!old.length) return `没有超过 ${days} 天的条目。`;
      const ok = await requestApproval({ category: '永久删除', action: `清空回收站里 ${old.length} 个超过 ${days} 天的条目`, detail: old.slice(0, 15).map((m) => m.originalPath).join('\n') });
      if (!ok) return denied('永久删除');
      for (const m of old) await fsp.rm(trashEntryDir(m.id), { recursive: true, force: true });
      appendLog('actions.jsonl', { tool: 'trash_purge', count: old.length, olderThanDays: days });
      return `已永久删除 ${old.length} 个条目。`;
    },
  },

  proc_run: {
    description: '运行一条 PowerShell 命令并返回输出。直接执行；只有永久删除、对外发出、改写历史、系统级改动等撤不回来的命令需要用户批准。删除文件请用 fs_delete（有回收站）。',
    schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutSec: { type: 'integer' } }, required: ['command'] },
    async run({ command, cwd, timeoutSec }) {
      // Classify the whole command line; a harmless prefix such as "dir;" must not hide what follows.
      const why = classifyCommand(command);
      if (why) {
        const ok = await requestApproval({ category: why, action: '运行命令', detail: command });
        if (!ok) return denied(why);
      }
      const dir = cwd ? resolvePath(cwd) : process.cwd();
      const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: dir, env: process.env, timeoutSec: Number(timeoutSec) || 600 });
      appendLog('actions.jsonl', { tool: 'proc_run', command: truncate(command, 2000), cwd: dir, exitCode: r.code, approvedAs: why });
      return truncate([`退出码 ${r.code}${r.timedOut ? '（超时被终止）' : ''} · 用时 ${r.seconds} 秒`, r.stdout.trim() && `--- 输出 ---\n${r.stdout.trim()}`, r.stderr.trim() && `--- 错误输出 ---\n${r.stderr.trim()}`].filter(Boolean).join('\n'));
    },
  },

  dispatch: {
    description: '执行任务并等回执，每次实时查询四家额度。普通执行、生图、TTS、视频直接派发；仅生图单次>5张或一分钟>5次需审核。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    schema: { type: 'object', properties: {
      task: { type: 'string', description: '完整任务说明（对方看不到你的对话）' },
      category: { type: 'string', enum: Object.keys(ROUTING.categories) },
      agent: { type: 'string', enum: ['auto', ...Object.keys(CONFIG.agents)], description: '默认 auto' },
      project: { type: 'string', description: '项目文件夹名，默认按工作目录判断' },
      cwd: { type: 'string' },
      timeoutSec: { type: 'integer' },
      generation: { type: 'string', enum: ['image', 'tts', 'video'], description: '生成任务的类型' },
      imageCount: { type: 'integer', minimum: 1, description: '生图必须填写本次总张数，包含所有变体' },
    }, required: ['task', 'category'] },
    run: dispatch,
  },

  quota: {
    readOnly: true,
    description: '每次实时查询四家额度，不复用旧回执；失败显示未知。',
    schema: { type: 'object', properties: {} },
    async run() {
      const q = await readQuotas();
      const label = { ok: '充足', low: '不足', unknown: '未知' };
      return Object.entries(q).map(([name, v]) => `${CONFIG.agents[name]?.label || name}：${label[v.status] || v.status}${v.remaining != null ? `（最紧的窗口剩 ${v.remaining}%）` : ''} — ${v.detail}${v.fetchedAt ? `；数据时间 ${v.fetchedAt}` : ''}；本次查询 ${v.checkedAt || '测试数据'}${v.source ? `；来源 ${v.source}` : ''}`).join('\n')
        + `\n判定规则：最紧的窗口剩余低于 ${ROUTING.lowQuotaPercent}% 视为不足；数据超过 ${ROUTING.staleAfterHours} 小时视为未知（未知不算不足）。`;
    },
  },

  route_preview: {
    readOnly: true,
    description: '某类活现在会派给谁（不派）。',
    schema: { type: 'object', properties: { category: { type: 'string', enum: Object.keys(ROUTING.categories) } }, required: ['category'] },
    async run({ category }) {
      const r = route(category, await readQuotas());
      return `${category} → ${r.agent ?? '无人可派'}（${r.reason}）\n候选：${r.considered.join('，')}`;
    },
  },

  board: {
    readOnly: true,
    description: '本项目看板（只含本项目，默认最近 5 条）。',
    schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['dispatches', 'receipts', 'routing', 'approvals', 'actions', 'spend', 'quota-reads'] },
      limit: { type: 'integer' },
      project: { type: 'string' },
    }, required: ['kind'] },
    async run({ kind, limit, project }) {
      const n = Math.min(50, Number(limit) || 5);
      if (kind === 'receipts') {
        const dir = path.join(boardDir(project), 'receipts');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-n) : [];
        return files.length ? files.map((f) => path.join(dir, f)).join('\n') : '（本项目还没有回执）';
      }
      const rows = readLogTail(`${kind}.jsonl`, n, project);
      // one short line per record keeps the lead's context small
      const brief = (r) => [r.time?.slice(5, 16).replace('T', ' '), r.agent || r.picked || r.tool || r.category || r.reason, r.ok === undefined ? '' : r.ok ? '完成' : '失败', r.receipt || r.id || r.reason || r.action || r.path || '', r.cny != null ? `${r.cny} 元` : '', r.approved === undefined ? '' : r.approved ? '已批准' : '已拒绝'].filter(Boolean).join(' · ');
      return rows.length ? rows.map(brief).join('\n') : `（${cleanProject(project)} 还没有 ${kind} 记录）`;
    },
  },

  ext_list: {
    readOnly: true,
    description: '列出 MCP\\extensions 里已安装的扩展（TTS、STT、视频模型等）。',
    schema: { type: 'object', properties: {} },
    async run() {
      const base = path.join(MCP_DIR, 'extensions');
      const out = [];
      if (!fs.existsSync(base)) return '没有扩展';
      for (const e of await fsp.readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('_')) continue;
        const mf = path.join(base, e.name, 'manifest.json');
        if (!fs.existsSync(mf)) { out.push(`${e.name}：预留位置，还没有安装扩展`); continue; }
        try { const m = JSON.parse(await fsp.readFile(mf, 'utf8')); out.push(`${e.name}：${m.displayName || m.id}（${m.kind}，${m.entry?.type}）`); } catch { out.push(`${e.name}：manifest.json 无法解析`); }
      }
      return out.join('\n') || '没有扩展';
    },
  },
};

// Every tool listed here costs context in every lead session, so leads get a small set
// (config.json "leaderTools"). Workers get none: they just do their task.
// AIO_HUB_TOOLS=all exposes everything (self-tests, or a lead that needs the trash-backed file tools).
const TOOL_NAMES = IS_WORKER ? [] : process.env.AIO_HUB_TOOLS === 'all' ? Object.keys(TOOLS) : CONFIG.leaderTools || Object.keys(TOOLS);
const ACTIVE_TOOLS = Object.fromEntries(TOOL_NAMES.filter((n) => TOOLS[n]).map((n) => [n, TOOLS[n]]));

const INSTRUCTIONS = IS_WORKER ? '' : [
  '.Allinone 领队规则：你负责拆分和派发，不亲自执行任务内容。',
  '1. 把任务拆成子任务，逐个调用 dispatch（写清 task 和 category），并行派发互不依赖的子任务。',
  '2. 不要读回执全文，把 dispatch 返回的回执路径和一句话结论转告用户即可；用户要看细节时再读。',
  '3. 用户已授权普通执行、生图、TTS和视频调用；正常传给所选服务不重复确认。生图须填imageCount；单次>5张或一分钟>5次由中心审核，其他不可撤销操作仍按权限协议。',
  '4. 日常任务不读安装手册、不跑health或自查；只在用户明确接入新模型/客户端时运行一次。dispatch自动查询全家实时额度，不引用历史回执。',
].join('\n');

// ---------------------------------------------------------------- MCP stdio transport

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        // Who started a hub, and in which mode: lets us check that workers never get lead tools.
        if (!process.env.AIO_HUB_BOARD) appendLog('hub-starts.jsonl', { worker: IS_WORKER, client: params?.clientInfo?.name, tools: Object.keys(ACTIVE_TOOLS).length });
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aio-hub', version: VERSION },
          instructions: INSTRUCTIONS,
        } });
        return;
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: Object.entries(ACTIVE_TOOLS).map(([name, t]) => ({
          name, description: t.description, inputSchema: t.schema,
          annotations: t.annotations || { readOnlyHint: !!t.readOnly, ...(t.readOnly ? { destructiveHint: false, idempotentHint: true, openWorldHint: name !== 'board' } : {}) },
        })) } });
        return;
      case 'tools/call': {
        const tool = ACTIVE_TOOLS[params?.name];
        if (!tool) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `没有这个工具：${params?.name}` }], isError: true } }); return; }
        try {
          const text = await tool.run(params.arguments || {});
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
        } catch (e) {
          appendLog('actions.jsonl', { tool: params.name, error: e.message });
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `出错：${e.message}` }], isError: true } });
        }
        return;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
