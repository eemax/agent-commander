// Turning a command's raw log into what the model reads: terminal noise removed, binary output
// replaced, and long output cut to its head and tail with a pointer to the full file.
import * as fs from "node:fs";

// CSI (colors, cursor moves), OSC (titles, hyperlinks) and other two-byte escape sequences.
// oxlint-disable-next-line no-control-regex -- matching terminal control codes is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Control characters other than tab and newline.
// oxlint-disable-next-line no-control-regex -- see above
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

// Strips escape codes and keeps only what a carriage-return progress bar finally showed.
export function cleanOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const last = line.lastIndexOf("\r");
      return last === -1 ? line : line.slice(last + 1);
    })
    .join("\n")
    .replace(CONTROL, "");
}

function isBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, read);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

export type ReadOutput = { text: string; truncated: boolean };

// Reads a log for the model: at most `cap` characters, keeping 40% head and 60% tail. Never
// loads more than a few times `cap` from disk, however large the file is.
export function readOutput(file: string, cap: number): ReadOutput {
  if (!fs.existsSync(file)) return { text: "", truncated: false };
  const size = fs.statSync(file).size;
  if (size === 0) return { text: "", truncated: false };
  const headCap = Math.floor(cap * 0.4);
  const tailCap = cap - headCap;
  const window = cap * 2; // bytes read from each end; cleaning only ever shrinks text
  const fd = fs.openSync(file, "r");
  try {
    if (size <= window * 2) {
      const raw = readRange(fd, 0, size);
      if (isBinary(raw.subarray(0, 8192))) return { text: `[binary output, ${formatBytes(size)}; file: ${file}]`, truncated: true };
      const text = cleanOutput(raw.toString("utf8"));
      if (text.length <= cap) return { text, truncated: false };
      const omitted = text.length - headCap - tailCap;
      return {
        text: `${text.slice(0, headCap)}\n\n[... ${omitted} characters truncated; full output: ${file} ...]\n\n${text.slice(-tailCap)}`,
        truncated: true
      };
    }
    const headRaw = readRange(fd, 0, window);
    if (isBinary(headRaw.subarray(0, 8192))) return { text: `[binary output, ${formatBytes(size)}; file: ${file}]`, truncated: true };
    let tail = cleanOutput(readRange(fd, size - window, window).toString("utf8"));
    tail = tail.slice(tail.indexOf("\n") + 1); // the window starts mid-line
    const head = cleanOutput(headRaw.toString("utf8")).slice(0, headCap);
    return {
      text: `${head}\n\n[... output truncated (${formatBytes(size)} in total); full output: ${file} ...]\n\n${tail.slice(-tailCap)}`,
      truncated: true
    };
  } finally {
    fs.closeSync(fd);
  }
}

// The last lines of a log, cleaned, for job notices.
export function tailLines(file: string, lines: number, maxChars: number): string {
  if (!fs.existsSync(file)) return "";
  const size = fs.statSync(file).size;
  if (size === 0) return "";
  const length = Math.min(size, 16_384);
  const fd = fs.openSync(file, "r");
  let raw: Buffer;
  try {
    raw = readRange(fd, size - length, length);
  } finally {
    fs.closeSync(fd);
  }
  if (isBinary(raw)) return `[binary output, ${formatBytes(size)}]`;
  let text = cleanOutput(raw.toString("utf8"));
  if (length < size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
  text = text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}
