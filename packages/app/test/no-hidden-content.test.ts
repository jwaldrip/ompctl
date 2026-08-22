/**
 * Nothing in this interface may hide something else.
 *
 * Two ways it already had. A session row laid its four readings across the
 * full row width while the action buttons sat at the trailing edge as later
 * siblings, so the size reading ran underneath them and only the sliver in
 * the gap between the two buttons was visible: on an iPad the number read
 * `10.` and then a stray `e`. And the notice floated absolutely above the
 * composer, which on 2026-08-19 put a connectivity complaint physically on
 * top of the reply it was complaining about not receiving.
 *
 * Both are the same defect wearing different clothes, so both are pinned
 * here as a class rather than as two screen fixes. The rules are the ones
 * that actually make occlusion impossible:
 *
 * - a row clips its own content, so nothing can paint outside its box;
 * - a flex item holding text can shrink, because a flex item's minimum is its
 *   content by default and that floor is what produces the overflow;
 * - a row of readings wraps rather than overflowing;
 * - a notice is a band in the column, not a layer over it.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const root = `${import.meta.dir}/..`;

async function source(file: string): Promise<string> {
  return await Bun.file(`${root}/${file}`).text();
}

/** The body of one `StyleSheet.create` entry, so a rule is read from the style it belongs to rather than from the file at large. */
function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`${name}: {`);
  if (start === -1) throw new Error(`no style named ${name}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated style ${name}`);
}

describe("a session row cannot paint under its own actions", () => {
  test("the row clips, the body can shrink, and the readings wrap", async () => {
    const text = await source("src/components/SessionRow.tsx");
    expect(styleBlock(text, "row")).toContain('overflow: "hidden"');
    // Without this the readings set a floor the body cannot go under, and the
    // overflow lands beneath the actions.
    expect(styleBlock(text, "body")).toContain("minWidth: 0");
    expect(styleBlock(text, "readings")).toContain('flexWrap: "wrap"');
  });
});

describe("a notice occupies space rather than covering it", () => {
  test("the toast is not absolutely positioned", async () => {
    const text = await source("src/components/Toast.tsx");
    expect(styleBlock(text, "toast")).not.toContain('position: "absolute"');
  });

  test("no component floats a dismissible notice over the console", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("src/components/*.tsx").scan({ cwd: root })) {
      const text = await source(file);
      // A notice is identified by what it does, not by its name: it carries a
      // live region for a screen reader and a tap that clears it.
      const isNotice = text.includes("accessibilityLiveRegion") && text.includes("onDismiss");
      if (isNotice && text.includes('position: "absolute"')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
