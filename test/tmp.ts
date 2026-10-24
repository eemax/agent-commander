// Temp directories for tests, removed after each test (test/setup.ts): the suite also runs on
// the server at every deploy, so anything left behind accumulates there.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const made: string[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acmd-${prefix}-`));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
