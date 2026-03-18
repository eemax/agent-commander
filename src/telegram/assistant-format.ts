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

const ZWSP = "\u200B";

/**
 * .md is a valid TLD, so Telegram auto-links `name.md` as a domain.
 * Other file extensions (.js, .ts, .py, etc.) are not TLDs and won't be linked.
 */
const FILE_EXTENSION_PATTERN = /(?<=\w)\.(?=md\b)/gi;

/**
 * Break patterns that Telegram auto-links but shouldn't be links:
 * - /command patterns (not part of a URL scheme)
 * - file.ext patterns (common source file extensions)
 */
function breakAutoLinks(text: string): string {
  // Break /word patterns: slash followed by a letter, not preceded by :, word char, or ;
  // (avoids breaking :// in URLs, paths within URLs, and HTML entities like &lt;/b&gt;)
  let result = text.replace(/(?<![:\w;])\/(?=[a-zA-Z])/g, `/${ZWSP}`);

  // Break .ext patterns for common file extensions
  result = result.replace(FILE_EXTENSION_PATTERN, `${ZWSP}.`);

  return result;
}

/**
 * Process HTML to insert ZWSP characters that prevent Telegram from
 * auto-linking /commands and file.ext references.
 * Preserves <a> href attributes and <pre> block content.
 */
function insertZwspBreakers(html: string): string {
  // Regex segments: <a>...</a> blocks | <pre>...</pre> blocks | other tags | text content
  return html.replace(
    /(<a\s[^>]*>)([\s\S]*?)(<\/a>)|(<pre[\s\S]*?<\/pre>)|(<[^>]+>)|([^<]+)/gi,
    (match, aOpen, aContent, aClose, preBlock, tag, text) => {
      if (aOpen) {
        // <a> tag: preserve href, break auto-links in display text only
        return aOpen + breakAutoLinks(aContent) + aClose;
      }
      if (preBlock) {
        // <pre> block: leave unchanged (code should display as-is)
        return preBlock;
      }
      if (tag) {
        // Other HTML tags: leave unchanged
        return tag;
      }
      if (text) {
        // Text content: apply ZWSP breaks
        return breakAutoLinks(text);
      }
      return match;
    }
  );
}

export function renderBasicTelegramHtml(markdown: string): string {
  const rendered = marked.parse(markdown, MARKED_OPTIONS);
  const sanitized = sanitizeHtml(rendered, SANITIZE_OPTIONS);
  return trimAndCollapseNewlines(sanitized);
}

export function renderMarkdownToTelegramHtml(markdown: string): string {
  const rendered = marked.parse(markdown, MARKED_OPTIONS);
  const sanitized = sanitizeHtml(rendered, SANITIZE_OPTIONS);
  const processed = insertZwspBreakers(sanitized);

  return trimAndCollapseNewlines(processed);
}
