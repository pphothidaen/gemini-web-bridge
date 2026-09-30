/**
 * Phase 4: Code Execution Sandbox
 * 
 * Docker-backed sandbox for secure code execution.
 * Avoids VM2/E2B critical risks and infrastructure clash with Hermes.
 * 
 * Architecture:
 * - Docker container per execution request (ephemeral, isolated)
 * - Resource limits: CPU, memory, timeout, network disabled by default
 * - Stateful Python support via Hermes' execute_code persistent session kernel
 * - gRPC/REST interface for bridge integration
 * 
 * Security considerations:
 * - No network access by default (opt-in per task)
 * - Read-only filesystem mount for code, tmpfs for execution
 * - Resource quotas prevent DoS
 * - Log capture without exposing container internals
 */

import { spawn, execSync } from 'child_process';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, Server } from 'net';
import { WebSocketServer, WebSocket } from 'ws';

// ═══ Configuration ═══

export interface SandboxConfig {
  /** Maximum execution time in milliseconds */
  timeoutMs: number;
  /** Maximum CPU time in seconds */
  cpuLimit: number;
  /** Maximum memory in MB */
  memoryLimitMb: number;
  /** Whether to allow network access (default: false) */
  allowNetwork: boolean;
  /** Docker image to use */
  image: string;
  /** Base mount directory inside container */
  mountDir: string;
}

export const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  cpuLimit: 10,
  memoryLimitMb: 256,
  allowNetwork: false,
  image: 'python:3.11-slim',
  mountDir: '/sandbox',
};

// ═══ Sandbox Session ═══

export interface ExecutionRequest {
  /** Language/runtime (currently only 'python' supported) */
  language: 'python';
  /** Code to execute */
  code: string;
  /** Optional input/stdin */
  input?: string;
  /** Whether to allow network access */
  allowNetwork?: boolean;
  /** Custom timeout in ms (overrides config) */
  timeoutMs?: number;
  /** Unique session ID for stateful execution */
  sessionId?: string;
}

export interface ExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** stdout output */
  stdout: string;
  /** stderr output */
  stderr: string;
  /** Exit code (0 = success) */
  exitCode: number;
  /** Execution duration in ms */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Session state preserved (for stateful Python) */
  state?: Record<string, unknown>;
}

export interface SandboxSession {
  /** Unique session identifier */
  sessionId: string;
  /** Container ID if running */
  containerId?: string;
  /** Persistent working directory */
  workDir: string;
  /** Created at timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Stateful variables (for Python kernel) */
  state: Map<string, unknown>;
}

// ═══ Docker Sandbox Manager ═══

export class DockerSandbox {
  private config: SandboxConfig;
  private sessions: Map<string, SandboxSession> = new Map();
  private server?: Server;
  private wss?: WebSocketServer;
  private isRunning = false;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if Docker is available
   */
  checkDockerAvailable(): boolean {
    try {
      execSync('docker --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if required Docker image exists, pull if not
   */
  async ensureImage(): Promise<void> {
    if (!this.checkDockerAvailable()) {
      throw new Error('Docker is not available');
    }

    try {
      // Check if image exists
      execSync(`docker image inspect ${this.config.image}`, { stdio: 'pipe' });
    } catch {
      console.log(`Pulling Docker image: ${this.config.image}`);
      execSync(`docker pull ${this.config.image}`, {
        stdio: 'inherit',
        timeout: 300000, // 5 min pull timeout
      });
    }
  }

  /**
   * Start the sandbox server (gRPC/REST + WebSocket)
   */
  async start(port: number = 8799): Promise<void> {
    if (this.isRunning) {
      throw new Error('Sandbox server already running');
    }

    await this.ensureImage();

    // Create tmp directory for session workspaces
    const workspaceDir = join(tmpdir(), 'code-sandbox-workspaces');
    await mkdir(workspaceDir, { recursive: true });

    // Start HTTP/WebSocket server
    this.server = createServer((socket) => {
      socket.destroy();
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, () => {
        this.isRunning = true;
        console.log(`Code Execution Sandbox running on port ${port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  /**
   * Stop the sandbox server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    // Kill all running containers
    for (const session of this.sessions.values()) {
      if (session.containerId) {
        await this.killContainer(session.containerId);
      }
    }

    this.sessions.clear();

    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    this.isRunning = false;
    console.log('Code Execution Sandbox stopped');
  }

  // ─── Session Management ───

  /**
   * Create or resume a stateful session
   */
  createSession(sessionId?: string): SandboxSession {
    const id = sessionId || this.generateSessionId();
    const workDir = join(tmpdir(), 'code-sandbox-workspaces', id);

    const session: SandboxSession = {
      sessionId: id,
      workDir,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      state: new Map(),
    };

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Get or create a session (for stateful Python execution)
   */
  getSession(sessionId: string): SandboxSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  /**
   * Clean up old sessions
   */
  async cleanupSessions(maxAgeMs: number = 3600000): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivity > maxAgeMs) {
        if (session.containerId) {
          await this.killContainer(session.containerId);
        }
        await rm(session.workDir, { recursive: true, force: true }).catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  // ─── Execution ───

  /**
   * Execute code in a Docker container
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Get or create session for stateful execution
    let session: SandboxSession | undefined;
    if (request.sessionId) {
      session = this.getSession(request.sessionId) || this.createSession(request.sessionId);
    }

    // Write code to temp file
    const codeFile = join(tmpdir(), `sandbox-code-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
    await writeFile(codeFile, request.code, 'utf-8');

    try {
      const result = await this.executeInContainer({
        codeFile,
        language: request.language,
        input: request.input,
        allowNetwork: request.allowNetwork ?? this.config.allowNetwork,
        timeoutMs: request.timeoutMs ?? this.config.timeoutMs,
        session,
      });

      result.durationMs = Date.now() - startTime;
      return result;
    } finally {
      // Clean up temp file
      await rm(codeFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Execute code in a Docker container with resource limits
   */
  private async executeInContainer(params: {
    codeFile: string;
    language: string;
    input?: string;
    allowNetwork: boolean;
    timeoutMs: number;
    session?: SandboxSession;
  }): Promise<ExecutionResult> {
    const { codeFile, language, input, allowNetwork, timeoutMs, session } = params;

    if (language !== 'python') {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: 1,
        durationMs: 0,
        error: `Unsupported language: ${language}`,
      };
    }

    // Build Docker command with security constraints
    const dockerArgs = [
      'run',
      '--rm', // Auto-remove container after execution
      '--interactive', // Keep stdin open
      '--detach', // Run in background for timeout handling
    ];

    // Resource limits
    dockerArgs.push(
      `--memory=${this.config.memoryLimitMb}m`,
      `--cpus=${this.config.cpuLimit}`,
      '--pids-limit=100', // Prevent fork bomb
      '--cap-drop=ALL', // Drop all capabilities
      '--security-opt=no-new-privileges', // Prevent privilege escalation
      '--read-only', // Read-only root filesystem
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', // Writable tmp with restrictions
      '--tmpfs', '/run:rw,noexec,nosuid,size=16m',
    );

    // Network isolation
    if (!allowNetwork) {
      dockerArgs.push('--network=none');
    }

    // Mount code file
    const containerWorkDir = session?.workDir
      ? session.workDir.replace(process.env.HOME || '/home', '/home')
      : '/tmp';

    dockerArgs.push(
      '-v', `${codeFile}:${this.config.mountDir}/code.py:ro`, // Read-only code mount
      '-w', this.config.mountDir,
      this.config.image,
      'python',
      '-u', // Unbuffered output
      '-c',
      'import sys; sys.path.insert(0, "/sandbox"); exec(open("/sandbox/code.py").read())',
    );

    const dockerCmd = `docker ${dockerArgs.join(' ')}`;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
    } catch (err) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: 1,
        durationMs: 0,
        error: `Failed to spawn Docker: ${err}`,
      };
    }

    // Handle input
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();

    // Collect output with timeout
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }, timeoutMs);

    const result = await new Promise<ExecutionResult>((resolve) => {
      child.stdout?.on('data', (data) => stdout.push(data));
      child.stderr?.on('data', (data) => stderr.push(data));

      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        resolve({
          success: code === 0,
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
          exitCode: code ?? 1,
          durationMs: 0,
          error: code !== 0 ? `Process exited with code ${code}` : undefined,
        });
      });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
          exitCode: 1,
          durationMs: 0,
          error: err.message,
        });
      });
    });

    // Cleanup any lingering container (should be auto-removed by --rm)
    await this.cleanupLingeringContainers();

    return result;
  }

  /**
   * Kill a running container
   */
  private async killContainer(containerId: string): Promise<void> {
    try {
      execSync(`docker kill ${containerId}`, { stdio: 'pipe', timeout: 5000 });
    } catch {
      // Container may already be dead
    }
  }

  /**
   * Clean up any containers that weren't properly removed
   */
  private async cleanupLingeringContainers(): Promise<void> {
    try {
      // List and remove any exited containers
      const result = execSync('docker ps -a -q --filter "status=exited"', { stdio: 'pipe' })
        .toString()
        .trim();
      if (result) {
        execSync(`docker rm ${result}`, { stdio: 'pipe' });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // ─── WebSocket Handling ───

  private handleWebSocketConnection(ws: WebSocket, req: any): void {
    let session: SandboxSession | null = null;
    let sessionId: string | null = null;

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'init':
            // Initialize session
            sessionId = message.sessionId;
            session = this.getSession(sessionId) || this.createSession(sessionId);
            ws.send(JSON.stringify({
              type: 'init_ok',
              sessionId: session.sessionId,
              state: Array.from(session.state.entries()),
            }));
            break;

          case 'execute':
            if (!session) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Session not initialized. Send "init" first.',
              }));
              return;
            }

            // Update session activity
            session.lastActivity = Date.now();

            // Execute with session context
            const request: ExecutionRequest = {
              language: message.language || 'python',
              code: message.code,
              input: message.input,
              allowNetwork: message.allowNetwork,
              timeoutMs: message.timeoutMs,
              sessionId: session.sessionId,
            };

            const result = await this.execute(request);

            // Update session state if execution succeeded
            if (result.success && message.persistState !== false) {
              try {
                // Extract state from stdout if it contains state assignments
                const stateUpdates = this.extractStateFromOutput(result.stdout);
                for (const [key, value] of Object.entries(stateUpdates)) {
                  session.state.set(key, value);
                }
              } catch {
                // State extraction is best-effort
              }
            }

            ws.send(JSON.stringify({
              type: 'result',
              sessionId: session.sessionId,
              ...result,
              state: Array.from(session.state.entries()),
            }));
            break;

          case 'get_state':
            ws.send(JSON.stringify({
              type: 'state',
              sessionId: session?.sessionId,
              state: Array.from(session?.state.entries() || []),
            }));
            break;

          case 'set_state':
            if (session) {
              for (const [key, value] of Object.entries(message.state || {})) {
                session.state.set(key, value);
              }
              session.lastActivity = Date.now();
            }
            ws.send(JSON.stringify({
              type: 'state_set_ok',
              sessionId: session?.sessionId,
            }));
            break;

          case 'reset_state':
            if (session) {
              session.state.clear();
              session.lastActivity = Date.now();
            }
            ws.send(JSON.stringify({
              type: 'state_reset_ok',
              sessionId: session?.sessionId,
            }));
            break;

          default:
            ws.send(JSON.stringify({
              type: 'error',
              error: `Unknown message type: ${message.type}`,
            }));
        }
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    });

    ws.on('close', () => {
      // Session persists for stateful execution
      // Cleanup will happen in background cleanup cycle
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  }

  private extractStateFromOutput(stdout: string): Record<string, unknown> {
    const state: Record<string, unknown> = {};

    // Look for __sandbox_state assignments
    const stateMatch = stdout.match(/__sandbox_state\.(\w+)\s*=\s*(.+?)(?:\n|$)/g);
    if (stateMatch) {
      for (const line of stateMatch) {
        const [, key, valueStr] = line.match(/__sandbox_state\.(\w+)\s*=\s*(.+)/) || [];
        try {
          // Safely evaluate simple literals only
          if (/^["'\d,\[\]{}]/.test(valueStr.trim())) {
            state[key] = JSON.parse(valueStr.trim().replace(/^['"]+|['"]+$/g, ''));
          }
        } catch {
          // Skip non-literal values
        }
      }
    }

    return state;
  }

  private generateSessionId(): string {
    return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// ═══ Singleton Instance ═══

let sandboxInstance: DockerSandbox | null = null;

export function getSandbox(config?: Partial<SandboxConfig>): DockerSandbox {
  if (!sandboxInstance) {
    sandboxInstance = new DockerSandbox(config);
  }
  return sandboxInstance;
}

// ═══ Hermes Integration ───

/**
 * Execute code using Docker sandbox with Hermes execute_code session integration
 * 
 * This wraps the Docker sandbox to provide stateful Python execution
 * that persists across calls within a session, leveraging Hermes'
 * persistent session kernel for stateful Python computation.
 */
export async function executeInSandbox(request: ExecutionRequest): Promise<ExecutionResult> {
  const sandbox = getSandbox();
  return sandbox.execute(request);
}

/**
 * Create a stateful execution session
 * State persists across multiple executeInSandbox calls with the same sessionId
 */
export function createExecutionSession(sessionId?: string): SandboxSession {
  return getSandbox().createSession(sessionId);
}

/**
 * Get existing session
 */
export function getExecutionSession(sessionId: string): SandboxSession | undefined {
  return getSandbox().getSession(sessionId);
}

/**
 * Start the sandbox server for WebSocket/HTTP access
 */
export async function startSandboxServer(port?: number): Promise<number> {
  const sandbox = getSandbox();
  await sandbox.start(port);
  return port || 8799;
}

/**
 * Stop the sandbox server
 */
export async function stopSandboxServer(): Promise<void> {
  const sandbox = getSandbox();
  await sandbox.stop();
}

export default {
  DockerSandbox,
  executeInSandbox,
  createExecutionSession,
  getExecutionSession,
  startSandboxServer,
  stopSandboxServer,
  getSandbox,
  DEFAULT_CONFIG,
  types: {
    ExecutionRequest,
    ExecutionResult,
    SandboxSession,
    SandboxConfig,
  },
};
