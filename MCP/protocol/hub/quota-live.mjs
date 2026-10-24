// Live, non-model quota queries. Never return session logs or cached utilization.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function codexRateLimits(command, env, cwd, timeoutMs = 30000, start = spawn) {
  return new Promise((resolve, reject) => {
    const child = start(command, ['-c', 'mcp_servers.aio-hub.enabled=false', 'app-server'], {
      env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex 额度查询超时')), timeoutMs);
    const send = (m) => { if (!done) child.stdin.write(JSON.stringify(m) + '\n'); };
    child.stdin.on('error', () => finish(new Error('Codex 查询连接关闭')));
    child.stderr.resume(); // No credential-bearing diagnostics enter receipts.
    child.on('error', () => finish(new Error('Codex 查询进程启动失败')));
    child.on('close', () => finish(new Error('Codex 查询提前退出')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffer += data;
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) { finish(new Error('Codex 查询握手失败')); continue; }
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        }
        if (m.id === 2) {
          if (m.error) finish(new Error('Codex 实时额度接口返回错误'));
          else finish(null, m.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'aio-quota', version: '1.0.0' }, capabilities: {} } });
  });
}

export async function claudeUsage(home, request = fetch) {
  // Credentials stay inside the local adapter and are sent only to Claude's own API.
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken; }
  catch { throw new Error('Claude 本地登录信息不可用'); }
  if (!token) throw new Error('Claude 登录没有可用的订阅令牌');
  const r = await request('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (!r.ok) throw new Error(`Claude 实时额度接口 HTTP ${r.status}`);
  return r.json();
}
