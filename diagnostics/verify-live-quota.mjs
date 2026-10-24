// Opt-in integration check: live quota reads, simulated worker, no model calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Lives in .Allinone\diagnostics; the hub stays in MCP\protocol\hub.
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'MCP', 'protocol', 'hub');
const work = fs.mkdtempSync(path.join(here, '.verify-live-'));
const board = path.join(work, 'board');
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
config.agents.fake = { label: '本地模拟队员', paid: false, command: process.execPath,
  args: ['-e', "require('fs').writeFileSync('output.txt','executed');console.log(JSON.stringify({type:'final',text:'模拟执行完成'}))"], parser: 'deepseek', env: {} };
config.routing.categories.livecheck = { label: '实时查询集成检查', tiers: [['fake']], lastResort: null };
const configFile = path.join(work, 'config.json');
fs.writeFileSync(configFile, JSON.stringify(config));
const child = spawn(process.execPath, [path.join(dir, 'hub.mjs')], { cwd: work, windowsHide: true,
  env: { ...process.env, AIO_AGENT: 'live-verification', AIO_HUB_QUOTA_FIXTURE: '', AIO_HUB_BOARD: board, AIO_HUB_CONFIG: configFile },
  stdio: ['pipe', 'pipe', 'inherit'] });
let next = 1, buffer = '';
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const id = next++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('实时检查超时')); }, 110000);
  pending.set(id, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error('MCP 请求失败')); else resolve(msg.result); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
child.stdout.on('data', (data) => {
  buffer += data;
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
const closed = new Promise((resolve) => child.on('close', resolve));
try {
  await send('initialize', { clientInfo: { name: 'live-quota-verification', version: '1' } });
  for (const agent of ['fake', 'auto']) {
    const result = await send('tools/call', { name: 'dispatch', arguments: { agent, category: 'livecheck', project: 'quota-check', cwd: work, task: '只执行本地模拟动作' } });
    assert(!result.isError && /本地模拟队员 完成/.test(result.content[0].text));
  }
  const reads = fs.readFileSync(path.join(board, 'projects/quota-check/quota-reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0].id, reads[1].id);
  for (const agent of ['codex', 'claude', 'gemini', 'deepseek']) {
    for (const read of reads) {
      assert(read.quotas[agent]?.fetchedAt, `${agent} 本次实时读取失败`);
      assert(Date.parse(read.quotas[agent].fetchedAt) >= Date.parse(read.checkedAt));
    }
    assert.notEqual(reads[0].quotas[agent].fetchedAt, reads[1].quotas[agent].fetchedAt);
    console.log(`${agent}：两次实时查询通过，${reads[0].quotas[agent].fetchedAt} → ${reads[1].quotas[agent].fetchedAt}`);
  }
  assert.equal(fs.readFileSync(path.join(work, 'output.txt'), 'utf8'), 'executed');
  console.log('指定派发、自动派发均查询全部四家并完成本地模拟执行；未调用生成模型。');
} finally {
  child.stdin.end();
  await closed;
  if (path.dirname(work) !== maintenance || !path.basename(work).startsWith('.verify-live-')) throw new Error('检查目录不在预期位置');
  fs.rmSync(work, { recursive: true, force: true });
}
