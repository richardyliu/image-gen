import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export class MissingBinaryError extends Error {
  constructor(public readonly bin: string) {
    super(`binary not found: ${bin}`);
    this.name = "MissingBinaryError";
  }
}

const MAX_CAPTURE = 512 * 1024;

export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    const append = (cur: string, chunk: Buffer) => (cur.length >= MAX_CAPTURE ? cur : cur + chunk.toString("utf8"));
    child.stdout.on("data", (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = append(stderr, c); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new MissingBinaryError(bin) : err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}
