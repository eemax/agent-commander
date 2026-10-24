import { describe, expect, it } from "vitest";
import { markWoken, parseCommand } from "../src/telegram/bot.js";
import { TELEGRAM_LIMIT, formatReply } from "../src/telegram/format.js";

const html = (md: string) => formatReply(md).map((c) => c.html).join("\n---\n");

describe("formatReply", () => {
  it("renders inline markdown as Telegram HTML", () => {
    expect(html("**bold** _it_ ~~gone~~ `x<y` [site](https://example.com)")).toBe(
      '<b>bold</b> <i>it</i> <s>gone</s> <code>x&lt;y</code> <a href="https://example.com">site</a>'
    );
  });

  it("escapes HTML in plain text", () => {
    expect(html("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("renders headings, lists and code blocks", () => {
    const out = html("# Title\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1 < 2;\n```");
    expect(out).toContain("<b>Title</b>");
    expect(out).toContain("• one\n• two");
    expect(out).toContain("1. a\n2. b");
    expect(out).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
  });

  it("drops non-http links to plain text", () => {
    expect(html("[x](javascript:alert(1))")).toBe("x");
  });

  it("shows tables as monospace", () => {
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toMatch(/^<pre>\| a \| b \|/);
  });

  it("splits long replies into chunks under the limit with balanced tags", () => {
    const md = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with **bold** text. ${"word ".repeat(30)}`).join("\n\n");
    const chunks = formatReply(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThan(TELEGRAM_LIMIT);
      expect(c.html.split("<b>").length).toBe(c.html.split("</b>").length);
    }
  });

  it("splits a huge code block into several closed code blocks", () => {
    const code = Array.from({ length: 800 }, (_, i) => `line ${i} <tag>`).join("\n");
    const chunks = formatReply(`\`\`\`\n${code}\n\`\`\``);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThan(TELEGRAM_LIMIT);
      expect(c.html.startsWith("<pre><code>")).toBe(true);
      expect(c.html.endsWith("</code></pre>")).toBe(true);
    }
    expect(chunks.map((c) => c.plain).join("\n")).toContain("line 799 <tag>");
  });

  it("returns nothing for empty text", () => {
    expect(formatReply("  \n ")).toEqual([]);
  });
});

describe("commands", () => {
  it("treats only known commands as commands", () => {
    expect(parseCommand("/status", [])).toEqual({ command: "status", arg: "" });
    expect(parseCommand("/Model kimi", [])).toEqual({ command: "model", arg: "kimi" });
    expect(parseCommand("/jobs stop 3", [])).toEqual({ command: "jobs", arg: "stop 3" });
    expect(parseCommand("/skill_creator make one", ["skill_creator"])).toEqual({ command: "skill_creator", arg: "make one" });
    expect(parseCommand("/var/log/syslog is full", [])).toBeNull();
    expect(parseCommand("/tmp has 2GB left", [])).toBeNull();
    expect(parseCommand("/stauts", [])).toBeNull();
  });
});

describe("woken replies", () => {
  it("never glue the marker onto a markdown block", () => {
    expect(markWoken("Build passed.")).toBe("⏰ Build passed.");
    for (const block of ["```\ncode\n```", "# Title", "- item", "1. step", "> quote", "| a | b |"]) {
      expect(markWoken(block)).toBe(`⏰\n\n${block}`);
    }
    expect(formatReply(markWoken("```\nx < y\n```"))[0]!.html).toBe("⏰\n\n<pre><code>x &lt; y</code></pre>");
  });
});
