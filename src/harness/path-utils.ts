import * as path from "node:path";

export function resolveToolPath(defaultCwd: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(defaultCwd, target);
}
