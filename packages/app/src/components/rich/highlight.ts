/**
 * Syntax highlighting tokenizer for code fences.
 *
 * Runs on React Native and the web without a DOM. Uses PrismJS core
 * with explicitly registered grammars and no auto-loader.
 */

import Prism from "prismjs";

// Grammars registered explicitly in dependency order
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-toml.js";

export interface Token {
  text: string;
  kind: string;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  diff: "diff",
  patch: "diff",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  css: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  markup: "markup",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

function resolveGrammar(lang: string | null): Prism.Grammar | null {
  if (!lang) {
    return null;
  }
  const normalized = lang.trim().toLowerCase();
  const canonical = LANGUAGE_ALIASES[normalized] ?? normalized;
  return Prism.languages[canonical] ?? null;
}

/**
 * Tokenizes code into lines of styled tokens.
 * Unknown or unhandled languages return one plain token per line.
 */
export function highlight(code: string, lang: string | null): Token[][] {
  const grammar = resolveGrammar(lang);
  if (!grammar) {
    return code.split(/\r?\n/).map(line => [{ text: line, kind: "plain" }]);
  }

  const rawTokens = Prism.tokenize(code, grammar);
  const lines: Token[][] = [[]];

  function pushSegment(text: string, kind: string): void {
    const parts = text.split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
      }
      const part = parts[i];
      if (part && part.length > 0) {
        const currentLine = lines[lines.length - 1];
        if (currentLine) {
          currentLine.push({ text: part, kind });
        }
      }
    }
  }

  function processToken(item: string | Prism.Token, parentKind: string): void {
    if (typeof item === "string") {
      pushSegment(item, parentKind);
    } else if (Array.isArray(item.content)) {
      const kind = item.type || parentKind;
      for (const child of item.content) {
        processToken(child, kind);
      }
    } else if (typeof item.content === "object" && item.content !== null) {
      processToken(item.content, item.type || parentKind);
    } else {
      pushSegment(String(item.content), item.type || parentKind);
    }
  }

  for (const item of rawTokens) {
    processToken(item, "plain");
  }

  // Ensure every line has at least one token
  for (const line of lines) {
    if (line.length === 0) {
      line.push({ text: "", kind: "plain" });
    }
  }

  return lines;
}
