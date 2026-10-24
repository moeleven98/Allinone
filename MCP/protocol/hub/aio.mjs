// .Allinone command-line tool: everything the hub can do, as plain scripts.
// No model is involved in any of these commands except `dispatch`, which by
// definition hands a task to one agent (that agent's quota is used, nothing else).
//
//   node aio.mjs health                     check installs, logins, registrations, guards (0 tokens)
//   node aio.mjs quota                      remaining quota of all four agents        (0 tokens)
//   node aio.mjs route <category>           who would get this kind of task, and why (0 tokens)
//   node aio.mjs dispatch <category|agent> <task...>   send a task (uses that agent's quota)
//   node aio.mjs new <project>              create MCP\projects\<project> from _template (with its own board)
//   node aio.mjs projects                   list projects and how many receipts each board has
//   node aio.mjs board <kind> [count] [project]   dispatches | receipts | routing | approvals | actions | spend
//   node aio.mjs trash [count]              list the trash
//
// The project is taken from the current folder (inside MCP\projects\<project>) unless given.
//   node aio.mjs restore <trash-id>         put a trashed item back
//   node aio.mjs selftest                   offline self-test of the hub (0 tokens)
//   node aio.mjs menu                       numbered menu (what the double-click launcher opens)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(HUB_DIR, '..', '..');
const USER_HOME = path.resolve(MCP_DIR, '..', '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'config.json'), 'utf8'));
const CATEGORIES = Object.keys(CONFIG.routing.categories);
const AGENTS = Object.keys(CONFIG.agents);
const NODE = process.execPath;

// ---------------------------------------------------------------- talking to the hub

const PROJECTS_DIR = path.join(MCP_DIR, 'projects');
const insideProjects = !path.relative(PROJECTS_DIR, process.cwd()).startsWith('..');

// Scripts get every hub tool (AIO_HUB_TOOLS=all); leads only get the small set from config.json.
function callHub(tool, args = {}) {
  return new Promise((resolve) => {
    const hub = spawn(NODE, [path.join(HUB_DIR, 'hub.mjs')], {
      cwd: insideProjects ? process.cwd() : PROJECTS_DIR, // the hub picks the project board from this folder
      env: { ...process.env, AIO_AGENT: 'aio-script', AIO_HUB_TOOLS: 'all' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    hub.stdout.setEncoding('utf8');
    hub.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.id === 2) {
          hub.stdin.end();
          resolve({ text: msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error ?? msg), isError: !!msg.result?.isError || !!msg.error });
        }
      }
    });
    const send = (m) => hub.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aio', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  });
}

async function show(tool, args) {
  const r = await callHub(tool, args);
  console.log(r.text);
  return r.isError ? 1 : 0;
}

// ---------------------------------------------------------------- health check (no model calls)

const expand = (v, vars) => v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function agentEnv(name) {
  const a = CONFIG.agents[name];
  const env = { ...process.env };
  for (const [k, v] of Object.entries(a.env || {})) { if (v === '') delete env[k]; else env[k] = expand(v, { MCP: MCP_DIR, PATH: process.env.PATH || '' }); }
  return env;
}

function run(cmd, args, env, timeoutMs = 60000) {
  const r = spawnSync(cmd, args, { env, cwd: path.join(MCP_DIR, 'projects'), encoding: 'utf8', timeout: timeoutMs, windowsHide: true, input: '' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const firstLine = (s) => (s || '').split(/\r?\n/).find((l) => l.trim()) || '';

async function health() {
  const rows = [];
  const add = (area, item, ok, detail) => rows.push({ area, item, mark: ok === true ? '✓' : ok === false ? '✗' : '⚠', detail });
  const exe = (name) => expand(CONFIG.agents[name].command, { MCP: MCP_DIR });

  add('运行环境', 'Node.js', true, `${process.version}（${NODE}）`);

  // versions
  const versions = {
    codex: run(exe('codex'), ['--version'], agentEnv('codex')),
    claude: run(exe('claude'), ['--version'], agentEnv('claude')),
    gemini: run(exe('gemini'), ['--version'], agentEnv('gemini')),
    deepseek: run(NODE, [path.join(MCP_DIR, 'agents', 'deepseek', 'bin', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'], agentEnv('deepseek')),
  };
  for (const [n, r] of Object.entries(versions)) add('程序', CONFIG.agents[n].label, r.code === 0, r.code === 0 ? firstLine(r.out) : `启动失败：${firstLine(r.out)}`);

  // logins (all local checks, no model calls)
  const cx = run(exe('codex'), ['login', 'status'], agentEnv('codex'));
  add('登录', 'Codex', /logged in/i.test(cx.out) && !/not logged in/i.test(cx.out), firstLine(cx.out));
  const cl = run(exe('claude'), ['auth', 'status'], agentEnv('claude'));
  let clIn = null; try { clIn = JSON.parse(cl.out.slice(cl.out.indexOf('{'))).loggedIn; } catch { /* not JSON */ }
  add('登录', 'Claude Code', clIn === true, clIn === true ? '已登录' : clIn === false ? '未登录' : firstLine(cl.out));
  const keyFile = path.join(MCP_DIR, 'agents', 'deepseek', 'home', 'deepseek-api-key.txt');
  const key = (read(keyFile) || '').replace(/^\uFEFF/, '').trim();
  add('登录', 'DeepSeek API 密钥', key.startsWith('sk-'), key ? `已放好（${key.length} 字符）` : '没有找到 deepseek-api-key.txt 或文件是空的');
  add('登录', 'agy（Gemini）', null, '凭证在 Windows 凭据管理器，由下面的额度查询间接验证');

  // hub registrations
  const claudeJson = read(path.join(MCP_DIR, 'agents', 'claude', 'home', '.claude.json')) || '';
  add('接入调度中心', 'Claude Code', /"aio-hub"/.test(claudeJson), 'agents\\claude\\home\\.claude.json');
  const codexToml = read(path.join(MCP_DIR, 'agents', 'codex', 'home', 'config.toml')) || '';
  add('接入调度中心', 'Codex', /\[mcp_servers\.aio-hub\]/.test(codexToml), 'agents\\codex\\home\\config.toml');
  const agyMcp = read(path.join(MCP_DIR, 'agents', 'gemini', 'home', '.gemini', 'config', 'mcp_config.json')) || '';
  add('接入调度中心', 'agy', /"aio-hub"/.test(agyMcp), 'agents\\gemini\\home\\.gemini\\config\\mcp_config.json');
  const dshPatch = read(path.join(MCP_DIR, 'agents', 'deepseek', 'home', 'profiles', 'web', 'cordis.patch.yml')) || '';
  add('接入调度中心', 'DSH（网页界面）', /mcp-aio-hub/.test(dshPatch), 'agents\\deepseek\\home\\profiles\\web\\cordis.patch.yml');

  // permission guards
  const claudeSettings = read(path.join(MCP_DIR, 'agents', 'claude', 'home', 'settings.json')) || '';
  add('权限守门', 'Claude 钩子', /guard\.mjs --for claude/.test(claudeSettings), 'settings.json 里的 PreToolUse 钩子');
  const agyHooks = read(path.join(MCP_DIR, 'agents', 'gemini', 'home', '.gemini', 'config', 'hooks.json')) || '';
  add('权限守门', 'agy 钩子', /guard\.mjs --for agy/.test(agyHooks) && !/\\"C:/.test(agyHooks), agyHooks ? 'hooks.json（路径不能带引号）' : '缺少 hooks.json');
  add('权限守门', 'Codex 命令规则', fs.existsSync(path.join(MCP_DIR, 'agents', 'codex', 'home', 'rules', 'allinone.rules')), 'rules\\allinone.rules');
  const sandbox = (codexToml.match(/^\s*sandbox\s*=\s*"(\w+)"/m) || [])[1];
  add('权限守门', 'Codex 沙箱', sandbox === 'unelevated' ? null : !!sandbox, `windows.sandbox = ${sandbox}${sandbox === 'unelevated' ? '（临时方案，官方修复后改回 elevated）' : ''}`);

  // guard script behaves as specified (pure local check)
  const gOk = /"ask"/.test(spawnSync(NODE, [path.join(HUB_DIR, 'guard.mjs'), '--for', 'claude'], { input: '{"tool_name":"Bash","tool_input":{"command":"git push"}}', encoding: 'utf8' }).stdout)
    && /"allow"/.test(spawnSync(NODE, [path.join(HUB_DIR, 'guard.mjs'), '--for', 'agy'], { input: '{"toolCall":{"name":"run_command","args":{"CommandLine":"npm test"}}}', encoding: 'utf8' }).stdout);
  add('权限守门', '守门脚本自检', gOk, gOk ? 'git push → 询问；npm test → 放行' : '判断结果不符合预期');

  // leftover background processes
  const ps = run('powershell.exe', ['-NoProfile', '-Command', `Get-Process | ? { $_.Path -like '${MCP_DIR}*' } | % { $_.ProcessName + ' ' + $_.Id }`], process.env);
  const procs = ps.out.split(/\r?\n/).filter((l) => l.trim() && !l.endsWith(` ${process.pid}`)); // not this script itself
  add('后台进程', '.Allinone 里正在运行的程序', procs.length === 0 ? true : null, procs.length ? procs.join('，') : '没有');

  // quotas (agy /usage and DeepSeek balance cost no tokens)
  const quota = await callHub('quota');
  const lines = quota.text.split('\n').filter((l) => /：/.test(l) && !/^判定规则/.test(l));
  for (const l of lines) {
    const [who, rest] = [l.slice(0, l.indexOf('：')), l.slice(l.indexOf('：') + 1)];
    add('额度', who, /^充足/.test(rest) ? true : /^不足/.test(rest) ? false : null, rest);
  }

  // print
  let area = '';
  for (const r of rows) {
    if (r.area !== area) { area = r.area; console.log(`\n【${area}】`); }
    console.log(`  ${r.mark} ${r.item}：${r.detail}`);
  }
  const bad = rows.filter((r) => r.mark === '✗').length;
  const warn = rows.filter((r) => r.mark === '⚠').length;
  console.log(`\n结果：${rows.length - bad - warn} 项正常，${warn} 项提醒，${bad} 项异常。（本次检查没有调用任何模型）`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------- commands

async function dispatchCmd(target, task) {
  if (!target || !task) { console.log(`用法：aio dispatch <类别或 agent> <任务>\n类别：${CATEGORIES.join(' ')}\nagent：${AGENTS.join(' ')}`); return 2; }
  const args = CATEGORIES.includes(target) ? { agent: 'auto', category: target, task } : { agent: target, task };
  console.log(`派活中（${CATEGORIES.includes(target) ? `自动选人，类别 ${target}` : `指定 ${target}`}）……这一步会消耗被派一方的额度。\n`);
  return show('dispatch', args);
}

// Published copies ship with {{MCP}} instead of a real install path (forward slashes work for
// node, Claude, Codex, agy and PowerShell alike).
const MCP_FWD = MCP_DIR.replaceAll('\\', '/');
function fillPlaceholders(file, extra = {}) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  // {{MCP_WIN_JSON}}: backslash path escaped for JSON (agy runs hooks through cmd /c, which wants backslashes).
  let after = before.replaceAll('{{MCP_WIN_JSON}}', MCP_DIR.replaceAll('\\', '\\\\')).replaceAll('{{MCP}}', MCP_FWD);
  for (const [k, v] of Object.entries(extra)) after = after.replaceAll(k, v);
  if (after !== before) fs.writeFileSync(file, after, 'utf8');
  return after !== before;
}

// First run after a fresh install: fill in this machine's path and put the per-agent
// config templates (setup\templates\agents) into MCP\agents\<agent>\home where missing.
function init() {
  const filled = [path.join(MCP_DIR, 'AGENTS.md'), path.join(MCP_DIR, '.codex', 'config.toml'),
    path.join(PROJECTS_DIR, 'AGENTS.md'), path.join(PROJECTS_DIR, '.mcp.json'), path.join(PROJECTS_DIR, '.codex', 'config.toml')]
    .filter((f) => fillPlaceholders(f, { __PROJECT__: '_root' }));
  const tplRoot = path.resolve(MCP_DIR, '..', 'setup', 'templates', 'agents');
  const copied = [];
  const kept = [];
  (function walk(rel) {
    const src = path.join(tplRoot, rel);
    if (!fs.existsSync(src)) return;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { walk(r); continue; }
      const dst = path.join(MCP_DIR, 'agents', r);
      if (fs.existsSync(dst)) { kept.push(r); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(tplRoot, r), dst);
      fillPlaceholders(dst);
      copied.push(r);
    }
  })('');
  fs.mkdirSync(path.join(MCP_DIR, 'board'), { recursive: true });
  console.log(`工作台位置：${MCP_DIR}`);
  console.log(`已填入本机路径的文件：${filled.length ? '\n  ' + filled.join('\n  ') : '（无，已经填过）'}`);
  console.log(`已放入的 agent 配置模板：${copied.length ? '\n  ' + copied.join('\n  ') : '（无）'}`);
  if (kept.length) console.log(`已存在、未覆盖：\n  ${kept.join('\n  ')}`);
  console.log('下一步：按 setup\\安装配置指南.md 安装各家程序、登录，然后运行 aio health。');
  return 0;
}

function newProject(name) {
  if (!name || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(name) || name.startsWith('_')) { console.log('用法：aio new <项目名>（字母、数字、中文、_ . -，不能以 _ 开头）'); return 2; }
  const dir = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(dir)) { console.log(`已存在：${dir}`); return 1; }
  fs.cpSync(path.join(PROJECTS_DIR, '_template'), dir, { recursive: true });
  // The project-level hub configs carry the project name so the hub files records on the right board,
  // and the install location in case the template still holds the {{MCP}} placeholder.
  for (const f of ['.mcp.json', path.join('.codex', 'config.toml'), 'AGENTS.md']) fillPlaceholders(path.join(dir, f), { __PROJECT__: name });
  fs.mkdirSync(path.join(MCP_DIR, 'board', 'projects', name, 'receipts'), { recursive: true });
  console.log(`已新建项目：${dir}\n看板：${path.join(MCP_DIR, 'board', 'projects', name)}\n在任意 harness 里把工作目录设到这个文件夹，它就会按领队规则派活。`);
  return 0;
}

function listProjects() {
  const rows = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => {
    const rdir = path.join(MCP_DIR, 'board', 'projects', e.name, 'receipts');
    const n = fs.existsSync(rdir) ? fs.readdirSync(rdir).filter((f) => f.endsWith('.md')).length : 0;
    return `  ${e.name}（回执 ${n} 份）`;
  });
  console.log(rows.length ? `项目：\n${rows.join('\n')}` : '还没有项目。用 aio new <项目名> 新建。');
  return 0;
}

function selftest() {
  // The self-test lives outside the working folder, in .Allinone\diagnostics.
  const r = spawnSync(NODE, [path.resolve(MCP_DIR, '..', 'diagnostics', 'selftest.mjs')], { stdio: 'inherit' });
  return r.status ?? 1;
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  // When input ends (window closed, or input piped in), behave as if "0 / exit" was chosen.
  const ask = async (q) => { if (closed) return '0'; try { return (await rl.question(q)).trim(); } catch { return '0'; } };
  const items = [
    ['1', '体检：程序、登录、接入、守门、后台进程、额度（不耗 Token）', () => health()],
    ['2', '查四家剩余额度（不耗 Token）', () => show('quota')],
    ['3', '预览：某类活现在会派给谁（不耗 Token）', async () => show('route_preview', { category: await askCategory() })],
    ['4', '自动派活（会消耗被派一方的额度）', async () => { const c = await askCategory(); const t = await ask('任务内容（一行）：'); return t ? dispatchCmd(c, t) : 0; }],
    ['5', '指定派给某一家（会消耗那一家的额度）', async () => { const a = await ask(`派给谁（${AGENTS.join(' / ')}）：`); const t = await ask('任务内容（一行）：'); return t ? dispatchCmd(a, t) : 0; }],
    ['6', '看某个项目的看板', async () => { listProjects(); const p = await ask('项目名（直接回车 = 公共区 _root）：') || '_root'; const k = await ask('哪种（dispatches / receipts / routing / approvals / actions / spend，回车 = dispatches）：') || 'dispatches'; return show('board', { kind: k, limit: 10, project: p }); }],
    ['9', '新建项目', async () => newProject(await ask('项目名：'))],
    ['7', '回收站：列出 / 还原', async () => { await show('trash_list', { limit: 20 }); const id = await ask('要还原的编号（直接回车跳过）：'); return id ? show('trash_restore', { id }) : 0; }],
    ['8', '调度中心离线自测（不耗 Token）', () => selftest()],
    ['0', '退出', null],
  ];
  async function askCategory() {
    CATEGORIES.forEach((c, i) => console.log(`  ${i + 1}. ${c}  ${CONFIG.routing.categories[c].label}`));
    const n = Number(await ask('选类别编号：'));
    return CATEGORIES[n - 1] || 'general';
  }
  for (;;) {
    console.log('\n===== .Allinone 调度中心 =====');
    for (const [k, label] of items) console.log(`  ${k}. ${label}`);
    const choice = await ask('请输入编号：');
    const item = items.find(([k]) => k === choice);
    if (!item || !item[2]) break;
    console.log('');
    try { await item[2](); } catch (e) { console.log(`出错：${e.message}`); }
  }
  rl.close();
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  init: () => init(),
  health: () => health(),
  quota: () => show('quota'),
  route: () => (rest[0] ? show('route_preview', { category: rest[0] }) : (console.log(`用法：aio route <类别>\n类别：${CATEGORIES.join(' ')}`), 2)),
  dispatch: () => dispatchCmd(rest[0], rest.slice(1).join(' ')),
  board: () => show('board', { kind: rest[0] || 'dispatches', limit: Number(rest[1]) || 10, ...(rest[2] ? { project: rest[2] } : {}) }),
  new: () => newProject(rest[0]),
  projects: () => listProjects(),
  trash: () => show('trash_list', { limit: Number(rest[0]) || 20 }),
  restore: () => show('trash_restore', { id: rest[0] }),
  selftest: () => selftest(),
  menu: () => menu(),
};
if (!commands[cmd]) {
  console.log('用法：aio <init | health | quota | route | dispatch | new | projects | board | trash | restore | selftest | menu> …');
  process.exitCode = 2;
} else {
  process.exitCode = await commands[cmd]();
}
