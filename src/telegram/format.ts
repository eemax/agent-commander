// Markdown -> Telegram HTML, split into chunks that each fit one message.
// Splitting happens on markdown blocks *before* rendering, so every chunk is self-contained
// HTML and no tag balancing is needed.
import { Lexer, type Token, type Tokens } from "marked";

export const TELEGRAM_LIMIT = 4096;
const BUDGET = 3800; // headroom under the hard limit

export type Chunk = { html: string; plain: string };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "strong":
      return `<b>${renderInline((token as Tokens.Strong).tokens)}</b>`;
    case "em":
      return `<i>${renderInline((token as Tokens.Em).tokens)}</i>`;
    case "del":
      return `<s>${renderInline((token as Tokens.Del).tokens)}</s>`;
    case "codespan":
      return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`;
    case "br":
      return "\n";
    case "link": {
      const link = token as Tokens.Link;
      const label = renderInline(link.tokens);
      return /^https?:\/\//i.test(link.href) ? `<a href="${escapeAttr(link.href)}">${label}</a>` : label;
    }
    case "image": {
      const image = token as Tokens.Image;
      return /^https?:\/\//i.test(image.href) ? `<a href="${escapeAttr(image.href)}">${escapeHtml(image.text || image.href)}</a>` : "";
    }
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : escapeHtml(text.text);
    }
    case "escape":
      return escapeHtml((token as Tokens.Escape).text);
    default:
      return escapeHtml("raw" in token ? String(token.raw) : "");
  }
}

function renderList(list: Tokens.List, depth: number): string {
  const indent = "  ".repeat(depth);
  const start = typeof list.start === "number" ? list.start : 1;
  return list.items
    .map((item, i) => {
      const bullet = list.ordered ? `${start + i}.` : item.task ? (item.checked ? "☑" : "☐") : "•";
      const body = item.tokens
        .map((t) => (t.type === "list" ? `\n${renderList(t as Tokens.List, depth + 1)}` : renderBlock(t, depth + 1).trim()))
        .join("\n")
        .replace(/\n{2,}/g, "\n");
      return `${indent}${bullet} ${body}`;
    })
    .join("\n");
}

function renderBlock(token: Token, depth = 0): string {
  switch (token.type) {
    case "heading":
      return `<b>${renderInline((token as Tokens.Heading).tokens)}</b>`;
    case "paragraph":
      return renderInline((token as Tokens.Paragraph).tokens);
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : escapeHtml(text.text);
    }
    case "code": {
      const code = token as Tokens.Code;
      const lang = code.lang?.trim().split(/\s+/)[0];
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      return `<pre><code${cls}>${escapeHtml(code.text)}</code></pre>`;
    }
    case "blockquote":
      return `<blockquote>${(token as Tokens.Blockquote).tokens.map((t) => renderBlock(t, depth)).join("\n")}</blockquote>`;
    case "list":
      return renderList(token as Tokens.List, depth);
    case "table":
      // Telegram has no tables; show the source as monospace so columns stay aligned.
      return `<pre>${escapeHtml(token.raw.trim())}</pre>`;
    case "hr":
      return "──────────";
    case "space":
      return "";
    default:
      return escapeHtml(token.raw);
  }
}

// Splits text that is too long on its own: prefer paragraph, then line, then hard cuts.
function splitPlain(text: string, budget: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf("\n\n", budget);
    if (cut < budget / 2) cut = rest.lastIndexOf("\n", budget);
    if (cut < budget / 2) cut = rest.lastIndexOf(" ", budget);
    if (cut < budget / 2) cut = budget;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

// One markdown block too big for a message: split it into smaller markdown pieces.
function splitBlock(token: Token): string[] {
  if (token.type === "code") {
    const code = token as Tokens.Code;
    const fence = "```";
    // Escaping can grow text; keep pieces well under budget.
    return splitPlain(code.text, Math.floor(BUDGET / 2)).map((piece) => `${fence}${code.lang ?? ""}\n${piece}\n${fence}`);
  }
  return splitPlain(token.raw, Math.floor(BUDGET / 2));
}

function renderMarkdown(markdown: string): string {
  return Lexer.lex(markdown)
    .map((t) => renderBlock(t))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

export function formatReply(markdown: string): Chunk[] {
  const text = markdown.trim();
  if (!text) return [];
  const blocks: string[] = [];
  for (const token of Lexer.lex(text)) {
    if (token.type === "space") continue;
    if (renderBlock(token).length > BUDGET) blocks.push(...splitBlock(token));
    else blocks.push(token.raw.trim());
  }

  const chunks: Chunk[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const plain = pending.join("\n\n");
    chunks.push({ html: renderMarkdown(plain), plain });
    pending = [];
  };
  for (const block of blocks) {
    const candidate = [...pending, block].join("\n\n");
    if (pending.length > 0 && renderMarkdown(candidate).length > BUDGET) flush();
    pending.push(block);
  }
  flush();
  return chunks.filter((c) => c.html.trim().length > 0 || c.plain.trim().length > 0);
}

export function splitPlainText(text: string): string[] {
  return splitPlain(text, BUDGET);
}
