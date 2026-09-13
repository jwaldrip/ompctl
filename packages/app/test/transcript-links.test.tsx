import "./rnw.ts";

import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Dynamic on purpose: `./rnw.ts` must mock react-native and register happy-dom
// before component modules evaluate their static graphs.
const { parseRich } = await import("../src/components/rich/parse.ts");
const { RichText } = await import("../src/components/rich/RichText.tsx");
const { brand } = await import("../src/design/tokens.ts");
const { Linking, StyleSheet } = await import("react-native");

const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

function declarationsFor(el: Element): Map<string, string> {
  const classes = el.className.split(/\s+/).filter(Boolean);
  const out = new Map<string, string>();
  const take = (text: string): void => {
    for (const declaration of text.matchAll(/([a-z-]+):\s*([^;]+);/gi)) {
      const property = declaration[1];
      const value = declaration[2];
      if (property === undefined || value === undefined) continue;
      out.set(property.toLowerCase(), value.replaceAll(" ", "").trim());
    }
  };
  for (const rule of rnwStyleSheet.getSheet().textContent.split("\n")) {
    if (!classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule))) continue;
    take(rule);
  }
  const inline = el.getAttribute("style");
  if (inline !== null) take(inline.endsWith(";") ? inline : `${inline};`);
  return out;
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},1.00)`;
}

describe("transcript links", () => {
  let openUrlSpy: Mock<(url: string) => Promise<void>>;
  const hosts: HTMLElement[] = [];

  beforeEach(() => {
    openUrlSpy = spyOn(Linking, "openURL").mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
    for (const host of hosts) {
      host.remove();
    }
    hosts.length = 0;
  });

  function renderRich(text: string): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const root = createRoot(host);
    act(() => {
      root.render(<RichText text={text} />);
    });
    return host;
  }

  test("pressing a markdown link opens the href through Linking.openURL", () => {
    const host = renderRich("here is [an example](https://example.com/test) link");
    const link = host.querySelector('[role="link"]') as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("an example");

    act(() => {
      link?.click();
    });

    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    expect(openUrlSpy).toHaveBeenCalledWith("https://example.com/test");
  });

  test("a bare https:// URL in agent text becomes a link and opens on press", () => {
    const blocks = parseRich("visit https://example.com/bare for details");
    expect(blocks).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "visit " },
          { kind: "link", text: "https://example.com/bare", href: "https://example.com/bare" },
          { kind: "text", text: " for details" },
        ],
      },
    ]);

    const host = renderRich("visit https://example.com/bare for details");
    const link = host.querySelector('[role="link"]') as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("https://example.com/bare");

    act(() => {
      link?.click();
    });

    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    expect(openUrlSpy).toHaveBeenCalledWith("https://example.com/bare");
  });

  test("javascript: and file: hrefs are refused and never handed to Linking.openURL", () => {
    const host = renderRich("check [run](javascript:alert) and [secret](file:///etc/passwd) now");
    const links = host.querySelectorAll('[role="link"]');
    expect(links.length).toBe(0);

    const spans = Array.from(host.querySelectorAll("span, div"));
    const runEl = spans.find(s => s.textContent === "run") as HTMLElement | undefined;
    const secretEl = spans.find(s => s.textContent === "secret") as HTMLElement | undefined;
    expect(runEl).toBeDefined();
    expect(secretEl).toBeDefined();

    act(() => {
      runEl?.click();
      secretEl?.click();
    });

    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  test("boundary cases: trailing punctuation is not swallowed into the URL", () => {
    const blocks1 = parseRich("see https://example.com/x.");
    expect(blocks1).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "see " },
          { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
          { kind: "text", text: "." },
        ],
      },
    ]);

    const blocks2 = parseRich("URLs: https://example.com/x, or https://example.com/y;");
    expect(blocks2).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "URLs: " },
          { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
          { kind: "text", text: ", or " },
          { kind: "link", text: "https://example.com/y", href: "https://example.com/y" },
          { kind: "text", text: ";" },
        ],
      },
    ]);

    const blocksParen = parseRich("nested (https://example.com/x)");
    expect(blocksParen).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "nested (" },
          { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
          { kind: "text", text: ")" },
        ],
      },
    ]);

    const blocksWiki = parseRich("wiki https://en.wikipedia.org/wiki/Function_(mathematics)");
    expect(blocksWiki).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "wiki " },
          {
            kind: "link",
            text: "https://en.wikipedia.org/wiki/Function_(mathematics)",
            href: "https://en.wikipedia.org/wiki/Function_(mathematics)",
          },
        ],
      },
    ]);

    const blocksWikiParen = parseRich("(see https://en.wikipedia.org/wiki/Function_(mathematics))");
    expect(blocksWikiParen).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "(see " },
          {
            kind: "link",
            text: "https://en.wikipedia.org/wiki/Function_(mathematics)",
            href: "https://en.wikipedia.org/wiki/Function_(mathematics)",
          },
          { kind: "text", text: ")" },
        ],
      },
    ]);
  });

  test("boundary cases: URLs inside code spans and fenced blocks stay literal", () => {
    const codeSpan = parseRich("see `https://example.com/code` verbatim");
    expect(codeSpan).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "text", text: "see " },
          { kind: "code", text: "https://example.com/code" },
          { kind: "text", text: " verbatim" },
        ],
      },
    ]);

    const fenced = parseRich("```\nhttps://example.com/fenced\n```");
    expect(fenced).toEqual([
      {
        kind: "code",
        lang: null,
        text: "https://example.com/fenced",
      },
    ]);
  });

  test("boundary cases: bare URL inside markdown link text is not re-linked", () => {
    const markdownWithUrlText = parseRich("[https://example.com/inner](https://example.com/outer)");
    expect(markdownWithUrlText).toEqual([
      {
        kind: "prose",
        spans: [{ kind: "link", text: "https://example.com/inner", href: "https://example.com/outer" }],
      },
    ]);
  });

  test("boundary cases: image ![alt](uri) continues to parse as attachment block", () => {
    const imageBlock = parseRich("![architecture](https://example.com/arch.png)");
    expect(imageBlock).toEqual([
      {
        kind: "attachment",
        ref: {
          uri: "https://example.com/arch.png",
          mime: null,
          name: "architecture",
          bytes: null,
        },
      },
    ]);
  });

  test("affordance: working link carries brand.azure and underline; refused link renders as plain text", () => {
    const host = renderRich("a [valid](https://example.com) and a [refused](javascript:void-0)");
    const link = host.querySelector('[role="link"]') as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("valid");

    const linkDecl = declarationsFor(link!);
    expect(linkDecl.get("color")).toBe(rgb(brand.azure));
    expect(linkDecl.get("text-decoration-line")).toBe("underline");

    const spans = Array.from(host.querySelectorAll("span, div"));
    const refusedEl = spans.find(s => s.textContent === "refused") as HTMLElement | undefined;
    expect(refusedEl).toBeDefined();
    expect(refusedEl?.getAttribute("role")).toBeNull();
    const refusedDecl = declarationsFor(refusedEl!);
    expect(refusedDecl.get("color")).not.toBe(rgb(brand.azure));
    expect(refusedDecl.get("text-decoration-line")).toBeUndefined();
  });
});
