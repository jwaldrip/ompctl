/**
 * Unit and render tests for GFM tables and nested lists.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Dynamic on purpose: `./rnw.ts` must mock react-native before the component
// modules load, so these cannot be static imports (see rnw.ts).
const { parseRich } = await import("../src/components/rich/parse.ts");
const { RichText } = await import("../src/components/rich/RichText.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("parseRich: tables", () => {
  test("a well-formed table with outer pipes", () => {
    const raw = ["| Name | Role |", "| :--- | :--- |", "| Alice | Admin |", "| Bob | User |"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "table",
        alignments: ["left", "left"],
        header: {
          cells: [[{ kind: "text", text: "Name" }], [{ kind: "text", text: "Role" }]],
        },
        rows: [
          {
            cells: [[{ kind: "text", text: "Alice" }], [{ kind: "text", text: "Admin" }]],
          },
          {
            cells: [[{ kind: "text", text: "Bob" }], [{ kind: "text", text: "User" }]],
          },
        ],
      },
    ]);
  });

  test("a well-formed table without outer pipes", () => {
    const raw = ["Command | Description", "--- | ---", "bun test | Run tests", "bun run check | Lint and types"].join(
      "\n",
    );
    expect(parseRich(raw)).toEqual([
      {
        kind: "table",
        alignments: [null, null],
        header: {
          cells: [[{ kind: "text", text: "Command" }], [{ kind: "text", text: "Description" }]],
        },
        rows: [
          {
            cells: [[{ kind: "text", text: "bun test" }], [{ kind: "text", text: "Run tests" }]],
          },
          {
            cells: [[{ kind: "text", text: "bun run check" }], [{ kind: "text", text: "Lint and types" }]],
          },
        ],
      },
    ]);
  });

  test("alignment colons", () => {
    const raw = ["| Left | Center | Right | None |", "| :--- | :---: | ---: | --- |", "| L | C | R | N |"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "table",
        alignments: ["left", "center", "right", null],
        header: {
          cells: [
            [{ kind: "text", text: "Left" }],
            [{ kind: "text", text: "Center" }],
            [{ kind: "text", text: "Right" }],
            [{ kind: "text", text: "None" }],
          ],
        },
        rows: [
          {
            cells: [
              [{ kind: "text", text: "L" }],
              [{ kind: "text", text: "C" }],
              [{ kind: "text", text: "R" }],
              [{ kind: "text", text: "N" }],
            ],
          },
        ],
      },
    ]);
  });

  test("a ragged row", () => {
    const raw = ["| A | B | C |", "| --- | --- | --- |", "| 1 |", "| 1 | 2 | 3 | 4 |"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "table",
        alignments: [null, null, null],
        header: {
          cells: [[{ kind: "text", text: "A" }], [{ kind: "text", text: "B" }], [{ kind: "text", text: "C" }]],
        },
        rows: [
          {
            cells: [[{ kind: "text", text: "1" }], [], []],
          },
          {
            cells: [[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }], [{ kind: "text", text: "3" }]],
          },
        ],
      },
    ]);
  });

  test("a malformed table falling through to prose", () => {
    const lonePipe = "| just a line with a pipe |";
    expect(parseRich(lonePipe)).toEqual([{ kind: "prose", spans: [{ kind: "text", text: lonePipe }] }]);

    const noHeader = "| --- | --- |\n| a | b |";
    expect(parseRich(noHeader)).toEqual([{ kind: "prose", spans: [{ kind: "text", text: noHeader }] }]);

    const malformedDelimiter = "| A | B |\n| not | delimiter |\n| 1 | 2 |";
    expect(parseRich(malformedDelimiter)).toEqual([
      { kind: "prose", spans: [{ kind: "text", text: malformedDelimiter }] },
    ]);
  });
});

describe("parseRich: nested lists", () => {
  test("a two-level unordered nest", () => {
    const raw = ["- root a", "  - child 1", "  - child 2", "- root b"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          {
            spans: [{ kind: "text", text: "root a" }],
            children: [
              {
                kind: "list",
                ordered: false,
                items: [
                  { spans: [{ kind: "text", text: "child 1" }] },
                  { spans: [{ kind: "text", text: "child 2" }] },
                ],
              },
            ],
          },
          {
            spans: [{ kind: "text", text: "root b" }],
          },
        ],
      },
    ]);
  });

  test("an ordered nest", () => {
    const raw = ["1. first", "   1. sub one", "   2. sub two", "2. second"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          {
            spans: [{ kind: "text", text: "first" }],
            children: [
              {
                kind: "list",
                ordered: true,
                items: [
                  { spans: [{ kind: "text", text: "sub one" }] },
                  { spans: [{ kind: "text", text: "sub two" }] },
                ],
              },
            ],
          },
          {
            spans: [{ kind: "text", text: "second" }],
          },
        ],
      },
    ]);
  });

  test("a nested list under an item", () => {
    const raw = ["- parent item", "  continuation paragraph", "  - sub item"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          {
            spans: [{ kind: "text", text: "parent item" }],
            children: [
              {
                kind: "prose",
                spans: [{ kind: "text", text: "continuation paragraph" }],
              },
              {
                kind: "list",
                ordered: false,
                items: [{ spans: [{ kind: "text", text: "sub item" }] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("mixed nesting", () => {
    const raw = ["1. step one", "   - bullet a", "   - bullet b", "2. step two"].join("\n");
    expect(parseRich(raw)).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          {
            spans: [{ kind: "text", text: "step one" }],
            children: [
              {
                kind: "list",
                ordered: false,
                items: [
                  { spans: [{ kind: "text", text: "bullet a" }] },
                  { spans: [{ kind: "text", text: "bullet b" }] },
                ],
              },
            ],
          },
          {
            spans: [{ kind: "text", text: "step two" }],
          },
        ],
      },
    ]);
  });
});

describe("RichText render: tables and nested lists", () => {
  test("a table renders as cells rather than a single text run", () => {
    const raw = ["| Head 1 | Head 2 |", "| --- | --- |", "| Cell A | Cell B |"].join("\n");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<RichText text={raw} />);
      });

      const headerCells = host.querySelectorAll('[data-testid^="table-header-cell"]');
      const bodyCells = host.querySelectorAll('[data-testid="table-cell"]');
      expect(headerCells.length).toBe(2);
      expect(bodyCells.length).toBe(2);
      expect(host.textContent).not.toContain("| --- | --- |");
      expect(host.textContent).toContain("Head 1");
      expect(host.textContent).toContain("Cell A");
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });

  test("alignment lands on table cells", () => {
    const raw = ["| Left | Center | Right |", "| :--- | :---: | ---: |", "| L1 | C1 | R1 |"].join("\n");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<RichText text={raw} />);
      });

      const leftCell = host.querySelector('[data-testid="table-header-cell-left"]');
      const centerCell = host.querySelector('[data-testid="table-header-cell-center"]');
      const rightCell = host.querySelector('[data-testid="table-header-cell-right"]');

      expect(leftCell).toBeDefined();
      expect(centerCell).toBeDefined();
      expect(rightCell).toBeDefined();
      expect(leftCell?.textContent).toContain("Left");
      expect(centerCell?.textContent).toContain("Center");
      expect(rightCell?.textContent).toContain("Right");
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });

  test("a nested list indents", () => {
    const raw = ["- root item", "  - nested item"].join("\n");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<RichText text={raw} />);
      });

      const nestedLists = host.querySelectorAll('[data-testid="nested-list"]');
      expect(nestedLists.length).toBe(1);
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});
