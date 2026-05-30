import { execa } from "execa";

export type AcpxRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runAcpx(args: string[], options: { cwd: string }): Promise<AcpxRunResult> {
  try {
    const result = await execa("acpx", args, {
      cwd: options.cwd,
      reject: false
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: (error as Error).message,
      exitCode: 1
    };
  }
}
