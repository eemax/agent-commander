import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";

const TELEGRAM_ALLOWED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "a",
  "code",
  "pre",
  "blockquote",
  "tg-spoiler",
  "span",
  "tg-emoji",
  "tg-time"
];

const TELEGRAM_ALLOWED_ATTRIBUTES = {
  a: ["href"],
  span: ["class"],
  "tg-emoji": ["emoji-id"],
  "tg-time": ["unix", "format"],
  blockquote: ["expandable"]
};

const TELEGRAM_ALLOWED_SCHEMES = ["http", "https", "tg", "mailto"];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function trimAndCollapseNewlines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function prefixMultiline(content: string, prefix: string, continuationPrefix: string): string {
  const lines = trimAndCollapseNewlines(content).split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0].length === 0)) {
    return prefix.trimEnd();
  }

  return lines.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`).join("\n");
}

const TELEGRAM_RENDERER = new marked.Renderer();

TELEGRAM_RENDERER.heading = function ({ tokens }: Tokens.Heading): string {
  const content = trimAndCollapseNewlines(this.parser.parseInline(tokens));
  if (content.length === 0) {
    return "";
  }
  return `<b>${content}</b>\n`;
};

TELEGRAM_RENDERER.paragraph = function ({ tokens }: Tokens.Paragraph): string {
  const content = trimAndCollapseNewlines(this.parser.parseInline(tokens));
  return content.length > 0 ? `${content}\n` : "";
};

TELEGRAM_RENDERER.list = function (token: Tokens.List): string {
  const start = typeof token.start === "number" ? token.start : 1;
  const lines = token.items.map((item, index) => {
    const marker = token.ordered ? `${start + index}. ` : "- ";
    const itemText = trimAndCollapseNewlines(this.parser.parse(item.tokens));
    return prefixMultiline(itemText, marker, "   ");
  });
  return lines.join("\n").concat("\n");
};

TELEGRAM_RENDERER.listitem = function (item: Tokens.ListItem): string {
  return trimAndCollapseNewlines(this.parser.parse(item.tokens));
};

TELEGRAM_RENDERER.checkbox = function ({ checked }: Tokens.Checkbox): string {
  return checked ? "[x] " : "[ ] ";
};

TELEGRAM_RENDERER.table = function (token: Tokens.Table): string {
  return `<pre><code>${escapeHtml(trimAndCollapseNewlines(token.raw))}</code></pre>\n`;
};

TELEGRAM_RENDERER.html = function ({ text }: Tokens.HTML | Tokens.Tag): string {
  return escapeHtml(text);
};

TELEGRAM_RENDERER.blockquote = function ({ tokens }: Tokens.Blockquote): string {
  const content = trimAndCollapseNewlines(this.parser.parse(tokens));
  return content.length > 0 ? `<blockquote>${content}</blockquote>\n` : "";
};

TELEGRAM_RENDERER.code = function ({ text }: Tokens.Code): string {
  return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
};

TELEGRAM_RENDERER.br = function (): string {
  return "\n";
};

TELEGRAM_RENDERER.hr = function (): string {
  return "\n";
};

TELEGRAM_RENDERER.image = function ({ href, text }: Tokens.Image): string {
  const label = text.trim().length > 0 ? text : "image";
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
};

const MARKED_OPTIONS = {
  async: false as const,
  gfm: true,
  breaks: true,
  renderer: TELEGRAM_RENDERER
};

const SANITIZE_OPTIONS = {
  allowedTags: TELEGRAM_ALLOWED_TAGS,
  allowedAttributes: TELEGRAM_ALLOWED_ATTRIBUTES,
  allowedClasses: { span: ["tg-spoiler"] },
  allowedSchemes: TELEGRAM_ALLOWED_SCHEMES,
  allowProtocolRelative: false
};

export function renderMarkdownToTelegramHtml(markdown: string): string {
  const rendered = marked.parse(markdown, MARKED_OPTIONS);
  const sanitized = sanitizeHtml(rendered, SANITIZE_OPTIONS);

  return trimAndCollapseNewlines(sanitized);
}
