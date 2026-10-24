// Call one hub tool from the command line, the same way a harness would.
// Handy for checking the hub without opening any harness.
//
//   node hubcall.mjs <tool> [json-arguments]
//   node hubcall.mjs quota
//   node hubcall.mjs dispatch "{\"agent\":\"deepseek\",\"task\":\"只回复：收到\"}"
//   node hubcall.mjs dispatch @args.json      (arguments read from a JSON file)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [tool, rawArgs] = process.argv.slice(2);
if (!tool) { console.error('用法：node hubcall.mjs <tool> [json-arguments]'); process.exit(2); }

const hub = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'MCP', 'protocol', 'hub', 'hub.mjs')], {
  env: { AIO_AGENT: 'hubcall', ...process.env },
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
      console.log(msg.result?.content?.[0]?.text ?? JSON.stringify(msg));
      process.exitCode = msg.result?.isError ? 1 : 0;
      hub.stdin.end();
    }
  }
});
const send = (m) => hub.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hubcall', version: '0' } } });
send({ method: 'notifications/initialized' });
const argText = rawArgs?.startsWith('@') ? fs.readFileSync(rawArgs.slice(1), 'utf8').replace(/^﻿/, '') : rawArgs;
send({ id: 2, method: 'tools/call', params: { name: tool, arguments: argText ? JSON.parse(argText) : {} } });
