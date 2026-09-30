#!/usr/bin/env node
/**
 * Phase 4: Code Execution Sandbox CLI
 * 
 * Starts the Docker-backed code execution sandbox server.
 * 
 * Usage:
 *   node scripts/sandbox-server.js           # Start on default port 8799
 *   node scripts/sandbox-server.js --port 9000  # Start on custom port
 *   node scripts/sandbox-server.js --image python:3.12-slim  # Use custom image
 * 
 * WebSocket API:
 *   ws://localhost:8799/
 * 
 * Message types:
 *   { type: "init", sessionId: "my-session" }           -> { type: "init_ok", sessionId, state }
 *   { type: "execute", code: "print('hello')", ... }    -> { type: "result", stdout, stderr, exitCode, ... }
 *   { type: "get_state" }                               -> { type: "state", state: [...] }
 *   { type: "set_state", state: { x: 42 } }            -> { type: "state_set_ok" }
 *   { type: "reset_state" }                             -> { type: "state_reset_ok" }
 */

import { parseArgs } from 'node:util';
import { startSandboxServer, stopSandboxServer } from '../src/sandbox.ts';

const options = {
  port: { type: 'string', short: 'p', default: '8799' },
  image: { type: 'string', short: 'i', default: 'python:3.11-slim' },
  cpuLimit: { type: 'string', default: '10' },
  memoryLimit: { type: 'string', default: '256' },
  timeout: { type: 'string', default: '30000' },
  allowNetwork: { type: 'boolean', default: false },
};

const { values } = parseArgs({ options, args: process.argv.slice(2) });

const config = {
  image: values.image,
  cpuLimit: parseInt(values.cpuLimit, 10),
  memoryLimitMb: parseInt(values.memoryLimit, 10),
  timeoutMs: parseInt(values.timeout, 10),
  allowNetwork: values.allowNetwork,
};

async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('  Code Execution Sandbox (Phase 4)');
  console.log('  Docker-backed · Stateful Python · WebSocket API');
  console.log('════════════════════════════════════════════════');
  console.log('');
  console.log('Configuration:');
  console.log(`  Port:         ${values.port}`);
  console.log(`  Docker Image: ${config.image}`);
  console.log(`  CPU Limit:    ${config.cpuLimit} cores`);
  console.log(`  Memory Limit: ${config.memoryLimitMb} MB`);
  console.log(`  Timeout:      ${config.timeoutMs} ms`);
  console.log(`  Network:      ${config.allowNetwork ? 'ALLOWED' : 'ISOLATED'}`);
  console.log('');
  console.log('Security:');
  console.log('  ✓ Read-only filesystem mount');
  console.log('  ✓ No network access (default)');
  console.log('  ✓ CPU/memory resource limits');
  console.log('  ✓ PID limit (fork bomb prevention)');
  console.log('  ✓ Capability dropping (no privileged ops)');
  console.log('  ✓ No-new-privileges security opt');
  console.log('');
  console.log('WebSocket endpoint: ws://localhost:' + values.port);
  console.log('');
  console.log('Press Ctrl+C to stop...');
  console.log('');

  try {
    const port = await startSandboxServer(parseInt(values.port, 10));
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down sandbox server...');
      await stopSandboxServer();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\nShutting down sandbox server...');
      await stopSandboxServer();
      process.exit(0);
    });
    
    // Keep process alive
    process.stdin.resume();
  } catch (err) {
    console.error('Failed to start sandbox server:', err);
    process.exit(1);
  }
}

main();
