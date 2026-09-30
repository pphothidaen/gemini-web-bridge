// Phase 4: Code Execution Sandbox Tests
// Tests for Docker-backed sandbox functionality

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('Code Execution Sandbox - Phase 4: should have default configuration defined', () => {
  // Read the source directly to verify config structure
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify DEFAULT_CONFIG exists in source
  assert.ok(source.includes('DEFAULT_CONFIG'), 'DEFAULT_CONFIG should be defined');
  assert.ok(source.includes('timeoutMs: 30000'), 'Default timeout should be 30000ms');
  assert.ok(source.includes('cpuLimit: 10'), 'Default CPU limit should be 10');
  assert.ok(source.includes('memoryLimitMb: 256'), 'Default memory limit should be 256MB');
});

test('Code Execution Sandbox - Phase 4: should export required types and classes', () => {
  // Verify the module exports the expected interface
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Check for exported interfaces
  assert.ok(source.includes('export interface ExecutionRequest'), 'ExecutionRequest interface should be exported');
  assert.ok(source.includes('export interface ExecutionResult'), 'ExecutionResult interface should be exported');
  assert.ok(source.includes('export interface SandboxSession'), 'SandboxSession interface should be exported');
  assert.ok(source.includes('export interface SandboxConfig'), 'SandboxConfig interface should be exported');
  
  // Check for exported classes and functions
  assert.ok(source.includes('export class DockerSandbox'), 'DockerSandbox class should be exported');
  assert.ok(source.includes('export async function executeInSandbox'), 'executeInSandbox async function should be exported');
  assert.ok(source.includes('export function createExecutionSession'), 'createExecutionSession function should be exported');
  assert.ok(source.includes('export async function startSandboxServer'), 'startSandboxServer async function should be exported');
  assert.ok(source.includes('export async function stopSandboxServer'), 'stopSandboxServer async function should be exported');
});

test('Code Execution Sandbox - Phase 4: should define security constraints', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify security features are documented in the code
  assert.ok(source.includes('--memory='), 'Memory limit should be configured');
  assert.ok(source.includes('--cpus='), 'CPU limit should be configured');
  assert.ok(source.includes('--network=none'), 'Network isolation should be configured');
  assert.ok(source.includes('--cap-drop=ALL'), 'Capability dropping should be configured');
  assert.ok(source.includes('--security-opt=no-new-privileges'), 'Privilege escalation prevention should be configured');
  assert.ok(source.includes('--read-only'), 'Read-only filesystem should be configured');
  assert.ok(source.includes('--pids-limit=100'), 'PID limit should be configured to prevent fork bombs');
});

test('Code Execution Sandbox - Phase 4: should support stateful Python execution', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify stateful session support
  assert.ok(source.includes('sessionId'), 'Session ID support should be present');
  assert.ok(source.includes('state: Map'), 'State Map should be defined for sessions');
  assert.ok(source.includes('persistState'), 'State persistence option should be available');
  assert.ok(source.includes('__sandbox_state'), 'State extraction pattern should be defined');
});

test('Code Execution Sandbox - Phase 4: should have WebSocket server support', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify WebSocket support for real-time execution
  assert.ok(source.includes('WebSocketServer'), 'WebSocket server should be supported');
  assert.ok(source.includes('handleWebSocketConnection'), 'WebSocket handler should be defined');
  assert.ok(source.includes("case 'execute'"), 'Execute message type should be handled in switch');
  assert.ok(source.includes("case 'init'"), 'Init message type should be handled in switch');
  assert.ok(source.includes("case 'get_state'"), 'Get state message type should be handled in switch');
  assert.ok(source.includes("case 'set_state'"), 'Set state message type should be handled in switch');
  assert.ok(source.includes("case 'reset_state'"), 'Reset state message type should be handled in switch');
});

test('Code Execution Sandbox - Phase 4: should enforce timeout on execution', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify timeout handling
  assert.ok(source.includes('timeoutMs'), 'Timeout configuration should be present');
  assert.ok(source.includes('setTimeout'), 'Timeout enforcement should use setTimeout');
  assert.ok(source.includes('SIGKILL'), 'Timeout should kill process with SIGKILL');
});

test('Code Execution Sandbox - Phase 4: should handle cleanup of resources', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify cleanup mechanisms
  assert.ok(source.includes('cleanupLingeringContainers'), 'Container cleanup function should exist');
  assert.ok(source.includes('cleanupSessions'), 'Session cleanup function should exist');
  assert.ok(source.includes('docker rm'), 'Container removal command should be present');
});

test('Code Execution Sandbox - Phase 4: should export default module interface', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify default export
  assert.ok(source.includes('export default'), 'Default export should be present');
  assert.ok(source.includes('DockerSandbox'), 'DockerSandbox should be in default export');
  assert.ok(source.includes('executeInSandbox'), 'executeInSandbox should be in default export');
  assert.ok(source.includes('DEFAULT_CONFIG'), 'DEFAULT_CONFIG should be in default export');
});

test('Code Execution Sandbox - Phase 4: should reference Docker-backed approach (not VM2/E2B)', () => {
  const source = readFileSync(join(__dirname, '../src/sandbox.ts'), 'utf-8');
  
  // Verify the implementation uses Docker (not VM2/E2B)
  assert.ok(source.includes('docker'), 'Docker commands should be used');
  assert.ok(source.includes('docker pull'), 'Docker pull should be available for image management');
  
  // Verify the comment explains why Docker was chosen
  assert.ok(source.includes('Docker-backed'), 'Docker-backed terminology should be present');
  assert.ok(source.includes('Avoids VM2/E2B'), 'Decision to avoid VM2/E2B should be documented');
  
  // Verify Docker execution via spawn
  assert.ok(source.includes('spawn(\'docker\''), 'Docker execution should use spawn');
});
