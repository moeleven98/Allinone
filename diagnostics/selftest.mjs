// Offline self-test for hub.mjs. Calls no model and shows no dialog:
// approvals are answered automatically (deny / approve) and the board,
// trash and test files live in a throwaway folder that is removed at the end.
//
//   ..\MCP\runtime\node\node.exe selftest.mjs     (or double-click selftest.cmd)
//
// This file lives in .Allinone\diagnostics, outside the working MCP folder.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageRequest, reserveImageRequest } from '../MCP/protocol/hub/image-policy.mjs';
import { codexRateLimits, claudeUsage } from '../MCP/protocol/hub/quota-live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..', 'MCP', 'protocol', 'hub', 'hub.mjs');
const WORK = fs.mkdtempSync(path.join(HERE, '_selftest-'));
const BOARD = path.join(WORK, 'board');
const FILES = path.join(WORK, 'files');
fs.mkdirSync(FILES, { recursive: true });
const defaultQuota = path.join(WORK, 'default-quota.json');
fs.writeFileSync(defaultQuota, JSON.stringify(Object.fromEntries(['codex', 'claude', 'gemini', 'deepseek'].map((n) => [n, { status: 'unknown', remaining: null }]))));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

function startHub(env, cwd = FILES) {
  const child = spawn(process.execPath, [HUB], { cwd, env: { ...process.env, AIO_AGENT: 'selftest', AIO_HUB_BOARD: BOARD, AIO_HUB_TOOLS: 'all', AIO_HUB_QUOTA_FIXTURE: defaultQuota, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  let next = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await request('tools/call', { name, arguments: args });
    return { text: r.result?.content?.[0]?.text ?? '', isError: !!r.result?.isError };
  };
  return { request, call, stop: () => child.stdin.end() };
}

const read = (p) => fs.readFileSync(p, 'utf8');
// FILES is not inside MCP\projects, so these hubs log to the "_root" project board.
const logLines = (name) => { const f = path.join(BOARD, 'projects', '_root', name); return fs.existsSync(f) ? read(f).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const trashId = (text) => (text.match(/\d{4}-\d{2}-\d{2}_[0-9a-f]{8}/) || [])[0];

try {
  console.log('1. 握手与工具列表');
  let hub = startHub({ AIO_HUB_APPROVAL: 'deny' });
  const init = await hub.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } });
  check('initialize 回应客户端请求的协议版本', init.result?.protocolVersion === '2025-06-18');
  check('initialize 带有领队规则', /领队规则/.test(init.result?.instructions || ''));
  const unknownVersion = await hub.request('initialize', { protocolVersion: '1999-01-01' });
  check('不认识的协议版本回落到最新支持版本', unknownVersion.result?.protocolVersion === '2026-07-28');
  const list = await hub.request('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('领队有 15 个工具', names.length === 15, `实际 ${names.length}: ${names.join(',')}`);
  check('每个工具都有输入结构', list.result.tools.every((t) => t.inputSchema?.type === 'object'));
  check('未知方法返回 -32601', (await hub.request('nope/x', {})).error?.code === -32601);

  console.log('2. 写文件：新建 / 覆盖备份 / 还原');
  const f = path.join(FILES, 'a.txt');
  let r = await hub.call('fs_write', { path: 'a.txt', content: 'v1' });
  check('新建文件不需要批准', /已新建/.test(r.text) && read(f) === 'v1');
  r = await hub.call('fs_write', { path: 'a.txt', content: 'v2' });
  const backup1 = trashId(r.text);
  check('覆盖时先备份到回收站', !!backup1 && read(f) === 'v2');
  r = await hub.call('fs_write', { path: 'a.txt', content: '+3', append: true });
  check('追加也先备份', !!trashId(r.text) && read(f) === 'v2+3');
  r = await hub.call('trash_restore', { id: backup1 });
  check('还原后内容回到 v1', read(f) === 'v1', r.text);
  check('还原时把当时的内容也备份了', !!trashId(r.text));
  check('没有产生任何批准请求', logLines('approvals.jsonl').length === 0);

  console.log('3. 删除 / 移动');
  fs.writeFileSync(path.join(FILES, 'b.txt'), 'bee');
  r = await hub.call('fs_delete', { path: 'b.txt' });
  const delId = trashId(r.text);
  check('删除进回收站、不需要批准', !!delId && !fs.existsSync(path.join(FILES, 'b.txt')));
  r = await hub.call('trash_list', {});
  check('回收站能列出删除的条目', r.text.includes(delId));
  await hub.call('trash_restore', { id: delId });
  check('删除的文件能还原', read(path.join(FILES, 'b.txt')) === 'bee');
  fs.writeFileSync(path.join(FILES, 'c.txt'), 'cee');
  r = await hub.call('fs_move', { from: 'b.txt', to: 'c.txt' });
  check('移动覆盖目标前，目标先进回收站', !!trashId(r.text) && read(path.join(FILES, 'c.txt')) === 'bee');
  fs.mkdirSync(path.join(FILES, 'dir', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(FILES, 'dir', 'sub', 'x.txt'), 'x');
  r = await hub.call('fs_delete', { path: 'dir' });
  check('整个文件夹也能进回收站', !!trashId(r.text) && !fs.existsSync(path.join(FILES, 'dir')));

  console.log('4. 读取 / 列表 / 搜索');
  r = await hub.call('fs_read', { path: 'c.txt' });
  check('读普通文件不需要批准', r.text.includes('bee'));
  fs.writeFileSync(path.join(FILES, 'auth.json'), '{"token":"secret"}');
  r = await hub.call('fs_read', { path: 'auth.json' });
  check('读敏感文件要批准，拒绝后不返回内容', /没有批准/.test(r.text) && !r.text.includes('secret'));
  r = await hub.call('fs_list', { path: '.' });
  check('列目录', r.text.includes('c.txt'));
  r = await hub.call('fs_search', { path: '.', pattern: 'bee' });
  check('按内容搜索', r.text.includes('c.txt:1'));
  check('搜索跳过敏感文件', !(await hub.call('fs_search', { path: '.', pattern: 'secret' })).text.includes('auth.json'));

  console.log('5. 运行命令：放权 / 不可撤销要批准');
  r = await hub.call('proc_run', { command: 'Write-Output hello' });
  check('普通命令直接执行', r.text.includes('hello'));
  for (const [cmd, label] of [
    ['Remove-Item c.txt', '永久删除'],
    ['dir; Remove-Item c.txt', '前缀不能掩盖删除'],
    ['cmd /c del c.txt', 'del'],
    ['git push origin main', '对外发出'],
    ['git reset --hard HEAD', '改写历史'],
    ['setx FOO bar', '系统级改动'],
    ['Invoke-WebRequest https://x.example -Method Post -Body 1', '对外 POST'],
  ]) {
    const before = logLines('approvals.jsonl').length;
    r = await hub.call('proc_run', { command: cmd });
    check(`拦截：${label}`, /没有批准/.test(r.text) && logLines('approvals.jsonl').length === before + 1, r.text.slice(0, 80));
  }
  check('被拒绝后文件还在', fs.existsSync(path.join(FILES, 'c.txt')));
  for (const cmd of ['Get-Content c.txt', 'npm run build', 'git status', 'node -e "console.log(1)"', 'Get-ChildItem -Recurse', 'python model_delete_check.py']) {
    const before = logLines('approvals.jsonl').length;
    await hub.call('proc_run', { command: cmd, timeoutSec: 20 });
    check(`不误拦：${cmd}`, logLines('approvals.jsonl').length === before);
  }

  console.log('6. 其他工具');
  r = await hub.call('trash_purge', { olderThanDays: 0 });
  check('清空回收站要批准，拒绝后条目还在', /没有批准/.test(r.text) && !/回收站是空的/.test((await hub.call('trash_list', {})).text));
  r = await hub.call('ext_list', {});
  // The published copy ships without MCP\extensions; then the tool must answer "没有扩展" instead of failing.
  const extDir = path.resolve(path.dirname(HUB), '..', '..', 'extensions');
  if (fs.existsSync(extDir)) check('扩展列表显示 3 个预留位置', (r.text.match(/预留位置/g) || []).length === 3, r.text);
  else check('没有扩展目录时，扩展列表正常回答“没有扩展”', !r.isError && r.text === '没有扩展', r.text);
  r = await hub.call('dispatch', { agent: 'nobody', task: 'x' });
  check('派给不存在的 agent 报错', r.isError && /不认识/.test(r.text));
  r = await hub.call('no_such_tool', {});
  check('不存在的工具报错', r.isError);
  r = await hub.call('board', { kind: 'approvals', limit: 3 });
  check('看板能读批准记录（每条一行简写）', r.text.includes('已拒绝') && !r.text.includes('{'));
  hub.stop();

  console.log('7. 批准后才执行');
  hub = startHub({ AIO_HUB_APPROVAL: 'approve' });
  await hub.request('initialize', {});
  fs.writeFileSync(path.join(FILES, 'gone.txt'), 'z');
  r = await hub.call('proc_run', { command: 'Remove-Item gone.txt' });
  check('批准后不可撤销命令被执行', !fs.existsSync(path.join(FILES, 'gone.txt')), r.text);
  check('批准记录 approved=true', logLines('approvals.jsonl').at(-1)?.approved === true);
  hub.stop();

  console.log('8. 领队只拿少量工具，队员不拿工具');
  hub = startHub({ AIO_HUB_APPROVAL: 'deny', AIO_HUB_TOOLS: '' });
  let init8 = await hub.request('initialize', {});
  const leadNames = (await hub.request('tools/list', {})).result.tools.map((t) => t.name).sort();
  check('领队默认只有 4 个工具', leadNames.join(',') === 'board,dispatch,quota,route_preview', leadNames.join(','));
  check('领队规则写在开场说明里：不亲自执行、只转交回执路径', /不亲自执行/.test(init8.result.instructions) && /回执路径/.test(init8.result.instructions));
  const listBytes = Buffer.byteLength(JSON.stringify((await hub.request('tools/list', {})).result) + init8.result.instructions);
  check(`领队看到的工具清单 + 规则一共不到 3 KB（实际 ${listBytes} 字节）`, listBytes < 3072);
  hub.stop();
  hub = startHub({ AIO_HUB_APPROVAL: 'deny', AIO_HUB_WORKER: '1' });
  init8 = await hub.request('initialize', {});
  const workerNames = (await hub.request('tools/list', {})).result.tools.map((t) => t.name);
  check('队员一个工具都没有、也没有领队规则', workerNames.length === 0 && !init8.result.instructions);
  r = await hub.call('fs_write', { path: 'w.txt', content: 'x' });
  check('队员调用写工具被拒', r.isError && !fs.existsSync(path.join(FILES, 'w.txt')));
  hub.stop();

  console.log('8b. 回执、分项目看板、额度用完自动换人（用假 agent，不调模型）');
  const PROJ = path.join(WORK, 'projects');
  for (const p of ['alpha', 'beta']) fs.mkdirSync(path.join(PROJ, p), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(HUB), 'config.json'), 'utf8'));
  const longText = '甲'.repeat(3000);
  const fakeOk = `console.log(JSON.stringify({type:'session',sessionId:'s-fake'}));console.log(JSON.stringify({type:'final',text:${JSON.stringify(longText)}+' | 任务:'+process.argv[1]}))`;
  const fakeLimit = "console.error('You have hit your usage limit. Try again later.');process.exit(1)";
  cfg.agents.fake = { label: '假队员', paid: false, command: process.execPath, args: ['-e', fakeOk, '{task}'], env: {}, parser: 'deepseek' };
  cfg.agents.fakelimit = { label: '额度用完的假队员', paid: false, command: process.execPath, args: ['-e', fakeLimit, '{task}'], env: {}, parser: 'deepseek' };
  cfg.routing.categories.testcat = { label: '测试', tiers: [['fakelimit', 'fake']], lastResort: null };
  const cfgFile = path.join(WORK, 'config.test.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  fs.writeFileSync(fixture0(), JSON.stringify({ fakelimit: { status: 'ok', remaining: 90 }, fake: { status: 'ok', remaining: 50 } }));
  function fixture0() { return path.join(WORK, 'quota0.json'); }
  const envP = { AIO_HUB_APPROVAL: 'deny', AIO_HUB_CONFIG: cfgFile, AIO_HUB_PROJECTS: PROJ, AIO_HUB_QUOTA_FIXTURE: fixture0() };
  const hubA = startHub(envP, path.join(PROJ, 'alpha'));
  const hubB = startHub(envP, path.join(PROJ, 'beta'));
  await hubA.request('initialize', {}); await hubB.request('initialize', {});
  r = await hubA.call('dispatch', { agent: 'fake', category: 'general', task: '写一篇长文' });
  const rcptPath = (r.text.match(/全文：(.+)/) || [])[1]?.trim();
  check('派活只返回几行：回执编号 + 路径 + 预览', /^回执 /.test(r.text) && r.text.split('\n').length <= 5, r.text.slice(0, 120));
  check(`返回给领队的内容很短（${Buffer.byteLength(r.text)} 字节），而回执全文有 ${rcptPath && fs.existsSync(rcptPath) ? fs.statSync(rcptPath).size : 0} 字节`, Buffer.byteLength(r.text) < 1200 && rcptPath && fs.statSync(rcptPath).size > 9000);
  check('回执写在 alpha 项目自己的看板里', !!rcptPath && rcptPath.includes(path.join('projects', 'alpha', 'receipts')));
  check('回执里有完整任务和完整回复', !!rcptPath && read(rcptPath).includes('写一篇长文') && read(rcptPath).includes(longText));
  check('队员在项目文件夹里干活', !!rcptPath && read(rcptPath).includes(path.join(PROJ, 'alpha')));
  r = await hubB.call('board', { kind: 'dispatches' });
  check('beta 的看板里看不到 alpha 的派活记录', /还没有/.test(r.text), r.text);
  r = await hubA.call('board', { kind: 'dispatches' });
  check('alpha 的看板里能看到，且每条只有一行', r.text.split('\n').length === 1 && /fake/.test(r.text), r.text);
  r = await hubA.call('board', { kind: 'receipts' });
  check('alpha 的回执列表能列出文件路径', r.text.includes('receipts'));
  r = await hubB.call('dispatch', { agent: 'auto', category: 'testcat', task: '测试换人' });
  check('额度用完自动换人：先派 fakelimit 失败，自动换成 fake 并完成', /假队员 完成/.test(r.text) && !/额度用完的假队员 完成/.test(r.text), r.text.slice(0, 160));
  const betaRouting = fs.readFileSync(path.join(BOARD, 'projects', 'beta', 'routing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('beta 的选人记录：第 1 次 fakelimit，第 2 次 fake', betaRouting.map((x) => x.picked).join(',') === 'fakelimit,fake');
  check('换人记录只在 beta，不在 alpha', !fs.existsSync(path.join(BOARD, 'projects', 'alpha', 'routing.jsonl')));
  check('公平轮流用的全局记录在 board 根目录', fs.existsSync(path.join(BOARD, 'picks.jsonl')));
  const auditA = path.join(BOARD, 'projects', 'alpha', 'quota-reads.jsonl');
  check('指定队员也有本次全家额度查询记录', JSON.parse(read(auditA).trim().split('\n')[0]).quotas.fake.remaining === 50);
  const auditB = read(path.join(BOARD, 'projects', 'beta', 'quota-reads.jsonl')).trim().split('\n');
  check('一次派发额度重试只记录一个派发查询编号', auditB.length === 1);

  console.log('8c. 生图审核边界与跨项目累计（假队员，不生成图片）');
  const dispatchSpec = (await hubA.request('tools/list', {})).result.tools.find((t) => t.name === 'dispatch');
  check('dispatch 如实声明会执行、会联网，派发本身不做破坏操作', dispatchSpec.annotations.readOnlyHint === false && dispatchSpec.annotations.destructiveHint === false && dispatchSpec.annotations.openWorldHint === true);
  let firstFive = [];
  for (let i = 0; i < 5; i++) firstFive.push(await hubA.call('dispatch', { agent: 'fake', category: 'image', imageCount: 1, task: '生成图片' }));
  check('一分钟前五次生图直接执行', firstFive.every((x) => /^回执 /.test(x.text)));
  r = await hubB.call('dispatch', { agent: 'fake', category: 'image', imageCount: 1, task: '生成图片' });
  check('另一个项目第六次被审核，拒绝后不执行', /没有批准/.test(r.text));
  const approvalB = path.join(BOARD, 'projects', 'beta', 'approvals.jsonl');
  check('审核记录属于发起审核的项目', JSON.parse(read(approvalB).trim().split('\n').at(-1)).category === '批量生图');
  const batchHub = startHub({ ...envP, AIO_HUB_BOARD: path.join(WORK, 'batch-board') });
  r = await batchHub.call('dispatch', { agent: 'fake', category: 'image', imageCount: 5, task: '生成图片' });
  check('单次五张直接执行', /^回执 /.test(r.text));
  r = await batchHub.call('dispatch', { agent: 'fake', category: 'image', imageCount: 6, task: '生成图片' });
  check('单次六张审核，拒绝不执行', /没有批准/.test(r.text));
  batchHub.stop();
  const approvedHub = startHub({ ...envP, AIO_HUB_APPROVAL: 'approve', AIO_HUB_BOARD: path.join(WORK, 'approved-batch') });
  r = await approvedHub.call('dispatch', { agent: 'fake', category: 'image', imageCount: 6, task: '生成图片' });
  check('批量生图批准后执行', /^回执 /.test(r.text));
  approvedHub.stop();
  const mediaHub = startHub({ ...envP, AIO_HUB_BOARD: path.join(WORK, 'media-board') });
  const media = await Promise.all(['tts', 'video'].map((generation) => mediaHub.call('dispatch', { agent: 'fake', category: 'general', generation, task: '执行本次生成任务' })));
  check('TTS、视频直接执行，无生图审核', media.every((x) => /^回执 /.test(x.text)) && !fs.existsSync(path.join(WORK, 'media-board', 'image-requests.jsonl')));
  mediaHub.stop();
  hubA.stop(); hubB.stop();

  console.log('8d. 计数并发、过期、参数校验');
  check('任务里更大的明确张数不能被 imageCount 降低', imageRequest({ category: 'image', imageCount: 1, task: '生成 6 张图片' }) === 6);
  let invalidCount = false;
  try { imageRequest({ category: 'image', imageCount: -1 }); } catch { invalidCount = true; }
  check('非法张数拒绝执行', invalidCount);
  const windowBoard = path.join(WORK, 'window-board');
  fs.mkdirSync(windowBoard);
  fs.writeFileSync(path.join(windowBoard, 'image-requests.jsonl'), Array.from({ length: 8 }, () => JSON.stringify({ time: Date.now() - 61000 })).join('\n'));
  check('一分钟前的申请不占本次窗口', (await reserveImageRequest(windowBoard, 1)).requestsInMinute === 1);
  // Real use has a single lead; what matters is that one lead firing more image tasks at once
  // than allowed gets the excess refused.
  const oneLead = startHub({ ...envP, AIO_HUB_BOARD: path.join(WORK, 'one-lead-burst') });
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => oneLead.call('dispatch', { agent: 'fake', category: 'image', imageCount: 1, task: `生成图片 ${i + 1}` })));
  check('一个领队同时派出 8 个生图任务：恰好 5 个执行，3 个被拒绝', burst.filter((x) => /^回执 /.test(x.text)).length === 5 && burst.filter((x) => /没有批准/.test(x.text)).length === 3, burst.map((x) => x.text.slice(0, 12)).join(' / '));
  oneLead.stop();

  console.log('8e. 实时额度适配器，不读历史缓存');
  const fakeClaudeHome = path.join(WORK, 'claude-home'); fs.mkdirSync(fakeClaudeHome);
  fs.writeFileSync(path.join(fakeClaudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-only' } }));
  let reads = 0;
  const liveFetch = async (url) => { reads++; check('Claude 查询固定官方地址', url === 'https://api.anthropic.com/api/oauth/usage'); return { ok: true, json: async () => ({ five_hour: { utilization: reads } }) }; };
  const c1 = await claudeUsage(fakeClaudeHome, liveFetch), c2 = await claudeUsage(fakeClaudeHome, liveFetch);
  check('Claude 连续两次重新请求，返回新值', reads === 2 && c1.five_hour.utilization === 1 && c2.five_hour.utilization === 2);
  let liveError = false;
  try { await claudeUsage(fakeClaudeHome, async () => ({ ok: false, status: 429 })); } catch (e) { liveError = /429/.test(e.message); }
  check('Claude 实时接口失败不回退旧缓存', liveError);
  const fakeServer = path.join(WORK, 'codex-server.cjs');
  fs.writeFileSync(fakeServer, `let b='';process.stdin.on('data',d=>{b+=d;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.id===1) console.log(JSON.stringify({id:1,result:{}}));if(m.method==='account/rateLimits/read') console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:37}}}}));}});`);
  let codexReads = 0;
  const fakeStart = (command, args, options) => { codexReads++; check('Codex 仅启动额度服务，未发起模型任务', args.includes('app-server') && !args.includes('exec')); return spawn(process.execPath, [fakeServer], options); };
  const d1 = await codexRateLimits('fake', process.env, WORK, 2000, fakeStart);
  const d2 = await codexRateLimits('fake', process.env, WORK, 2000, fakeStart);
  check('Codex 每次通过新请求读取实时额度', codexReads === 2 && d1.rateLimits.primary.usedPercent === 37 && d2.rateLimits.primary.usedPercent === 37);

  console.log('9. 按额度自动选人（用假额度，不调模型）');
  const fixture = path.join(WORK, 'quota.json');
  const preview = async (quotas, category) => {
    fs.writeFileSync(fixture, JSON.stringify(quotas));
    const h = startHub({ AIO_HUB_APPROVAL: 'deny', AIO_HUB_QUOTA_FIXTURE: fixture });
    await h.request('initialize', {});
    const t = (await h.call('route_preview', { category })).text;
    h.stop();
    return (t.match(/→ ([^（\s]+)/) || [])[1];
  };
  const q = (codex, claude, gemini, deepseek = 'ok') => ({
    codex: typeof codex === 'number' ? { status: codex < 10 ? 'low' : 'ok', remaining: codex } : { status: codex, remaining: null },
    claude: typeof claude === 'number' ? { status: claude < 10 ? 'low' : 'ok', remaining: claude } : { status: claude, remaining: null },
    gemini: typeof gemini === 'number' ? { status: gemini < 10 ? 'low' : 'ok', remaining: gemini } : { status: gemini, remaining: null },
    deepseek: { status: deepseek, remaining: null },
  });
  check('写代码：codex 剩 54%、claude 剩 30% → codex', (await preview(q(54, 30, 90), 'code')) === 'codex');
  check('写代码：codex 剩 20%、claude 剩 60% → claude（同梯队谁剩得多给谁）', (await preview(q(20, 60, 90), 'code')) === 'claude');
  check('写代码：codex 和 claude 都不足 → 后备 gemini', (await preview(q(5, 3, 90), 'code')) === 'gemini');
  check('写代码：三家订阅都不足 → deepseek 顶班', (await preview(q(5, 3, 2), 'code')) === 'deepseek');
  check('写代码：deepseek 也不可用 → 无人可派', (await preview(q(5, 3, 2, 'low'), 'code')) === '无人可派');
  check('读长文：gemini 充足 → gemini', (await preview(q(90, 90, 40), 'longtext')) === 'gemini');
  check('读长文：gemini 不足 → 后备里剩得多的 claude', (await preview(q(30, 70, 5), 'longtext')) === 'claude');
  check('额度未知不算不足：codex 未知、claude 剩 30% → 先选有数据的 claude', (await preview(q('unknown', 30, 90), 'code')) === 'claude');
  check('额度未知不算不足：codex 未知、claude 不足 → 选 codex 而不是跳到后备', (await preview(q('unknown', 3, 90), 'code')) === 'codex');
  check('生图：只有 codex，codex 不足 → 无人可派（不偷偷换人）', (await preview(q(5, 90, 90), 'image')) === '无人可派');
  check('通用：三家里剩得最多的 gemini', (await preview(q(40, 50, 80), 'general')) === 'gemini');
  fs.appendFileSync(path.join(BOARD, 'picks.jsonl'), JSON.stringify({ time: new Date(Date.now() + 5000).toISOString(), picked: 'codex' }) + '\n');
  check('完全打平（都剩 50%）时不偏向排在前面的：刚派过 codex → 这次 claude', (await preview(q(50, 50, 90), 'code')) === 'claude');
  fs.appendFileSync(path.join(BOARD, 'picks.jsonl'), JSON.stringify({ time: new Date(Date.now() + 6000).toISOString(), picked: 'claude' }) + '\n');
  check('完全打平时轮流：刚派过 claude → 这次 codex', (await preview(q(50, 50, 90), 'code')) === 'codex');

  console.log('10. 一个领队同时发出很多操作，看板不乱');
  const lead10 = startHub({ AIO_HUB_APPROVAL: 'deny' });
  const before = logLines('actions.jsonl').length;
  await Promise.all(Array.from({ length: 60 }, (_, k) => lead10.call('fs_write', { path: `p_${k}.txt`, content: 'x' })));
  const after = logLines('actions.jsonl');
  check('同时写 60 次，看板 60 行且每行都是完整 JSON', after.length - before === 60);
  lead10.stop();
} catch (e) {
  failed++;
  console.log(`  ✗ 测试中断：${e.stack}`);
} finally {
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}
