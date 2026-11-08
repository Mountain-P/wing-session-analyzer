#!/usr/bin/env node
import { runStdioServer } from '../src/mcp.mjs';
try { await runStdioServer(); }
catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error?.code || 'STARTUP_ERROR', message: error?.message || 'Server startup failed.' } }) + '\n');
  process.exitCode = 1;
}
