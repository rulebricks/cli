import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLayout,
  computeListWindow,
  computeSectionMenuLayout,
  FRAME_CHROME_ROWS,
  HEADER_ROWS_COMPACT,
  HEADER_ROWS_FULL,
  LOGO_BLOCK_ROWS,
  MAX_LIST_ROWS,
  MAX_STEP_BOX_ROWS,
  MIN_LIST_ROWS,
  MIN_STEP_BOX_ROWS,
  type SectionMenuLayout,
} from "./layout.js";

/** Total rows the shell renders for a layout (logo + frame + slots). */
function totalRows(layout: ReturnType<typeof computeLayout>): number {
  return (
    (layout.showLogo ? LOGO_BLOCK_ROWS : 0) +
    FRAME_CHROME_ROWS +
    layout.headerRows +
    layout.stepBoxHeight
  );
}

test("80x40 keeps the logo, full header, and a roomy step box", () => {
  const layout = computeLayout(40, 80);
  assert.equal(layout.tooSmall, false);
  assert.equal(layout.showLogo, true);
  assert.equal(layout.showProgressBar, true);
  assert.equal(layout.headerRows, HEADER_ROWS_FULL);
  assert.equal(layout.frameWidth, 70);
  assert.equal(layout.stepBoxWidth, 60);
  assert.equal(layout.listLimit, MAX_LIST_ROWS);
  assert.ok(totalRows(layout) < 40, "must stay strictly below terminal rows");
});

test("80x24 (default terminal) drops the logo but keeps the progress bar", () => {
  const layout = computeLayout(24, 80);
  assert.equal(layout.tooSmall, false);
  assert.equal(layout.showLogo, false);
  assert.equal(layout.showProgressBar, true);
  assert.equal(layout.stepBoxHeight, 15);
  assert.ok(totalRows(layout) < 24);
});

test("80x20 drops the progress bar and compacts the header", () => {
  const layout = computeLayout(20, 80);
  assert.equal(layout.tooSmall, false);
  assert.equal(layout.showLogo, false);
  assert.equal(layout.showProgressBar, false);
  assert.equal(layout.headerRows, HEADER_ROWS_COMPACT);
  assert.equal(layout.stepBoxHeight, 13);
  assert.equal(layout.listLimit, MIN_LIST_ROWS);
  assert.ok(totalRows(layout) < 20);
});

test("tiny terminals are flagged too small", () => {
  assert.equal(computeLayout(18, 80).tooSmall, true);
  assert.equal(computeLayout(12, 80).tooSmall, true);
  assert.equal(computeLayout(40, 40).tooSmall, true);
});

test("huge terminals cap the step box and list size", () => {
  const layout = computeLayout(80, 200);
  assert.equal(layout.stepBoxHeight, MAX_STEP_BOX_ROWS);
  assert.equal(layout.listLimit, MAX_LIST_ROWS);
  assert.equal(layout.frameWidth, 70);
});

test("narrow terminals shrink the frame and step box widths", () => {
  const layout = computeLayout(40, 60);
  assert.equal(layout.tooSmall, false);
  assert.equal(layout.frameWidth, 57);
  assert.equal(layout.stepBoxWidth, 53);
});

test("total height never reaches the terminal row count", () => {
  for (let rows = 16; rows <= 80; rows++) {
    const layout = computeLayout(rows, 80);
    if (layout.tooSmall) continue;
    assert.ok(
      totalRows(layout) < rows,
      `layout for ${rows} rows renders ${totalRows(layout)} rows`,
    );
  }
});

/** Rows the SectionMenu renders for a menu layout, mirroring its JSX. */
function menuRows(menu: SectionMenuLayout, sectionCount: number): number {
  const windowed = menu.windowSize < sectionCount;
  return (
    2 + // BorderBox borders
    2 + // StepFooter margin + hints
    1 + // outer top margin
    1 + // title
    (menu.showSubtitle ? 1 : 0) +
    (menu.showActions ? 2 : 0) +
    1 + // list top margin
    (windowed ? 2 : 0) + // overflow marker rows
    Math.min(menu.windowSize, sectionCount) +
    (menu.showReviewMargin ? 1 : 0) +
    1 + // pinned review row
    (menu.showDescription ? 2 : 0)
  );
}

test("tall step box windows a full section list with actions and description", () => {
  const menu = computeSectionMenuLayout(MAX_STEP_BOX_ROWS, 12);
  assert.equal(menu.windowSize, 6);
  assert.equal(menu.showActions, true);
  assert.equal(menu.showDescription, true);
  assert.equal(menu.showSubtitle, false);
  assert.equal(menu.showReviewMargin, false);
  assert.equal(menuRows(menu, 12), MAX_STEP_BOX_ROWS);
});

test("short section lists keep full chrome unwindowed", () => {
  const menu = computeSectionMenuLayout(MAX_STEP_BOX_ROWS, 6);
  assert.equal(menu.windowSize, 6);
  assert.equal(menu.showSubtitle, true);
  assert.equal(menu.showActions, true);
  assert.equal(menu.showReviewMargin, true);
  assert.equal(menu.showDescription, true);
});

test("shedding chrome can fit the whole list without windowing", () => {
  const menu = computeSectionMenuLayout(MAX_STEP_BOX_ROWS, 8);
  assert.equal(menu.windowSize, 8);
  assert.equal(menu.showSubtitle, false);
  assert.equal(menu.showReviewMargin, false);
  assert.equal(menu.showActions, true);
  assert.equal(menu.showDescription, true);
});

test("80x24 step box keeps the actions row at a minimal window", () => {
  // computeLayout(24, 80) yields a 15-row step box.
  const menu = computeSectionMenuLayout(15, 12);
  assert.equal(menu.windowSize, 3);
  assert.equal(menu.showActions, true);
  assert.equal(menu.showSubtitle, false);
  assert.equal(menu.showReviewMargin, false);
  assert.equal(menu.showDescription, false);
});

test("minimal step box sheds the actions row as a last resort", () => {
  const menu = computeSectionMenuLayout(MIN_STEP_BOX_ROWS, 12);
  assert.equal(menu.showActions, false);
  assert.ok(menu.windowSize >= 1);
});

test("section menu never overflows the step box", () => {
  for (
    let height = MIN_STEP_BOX_ROWS;
    height <= MAX_STEP_BOX_ROWS;
    height++
  ) {
    for (let count = 4; count <= 14; count++) {
      const menu = computeSectionMenuLayout(height, count);
      assert.ok(
        menuRows(menu, count) <= height,
        `menu for box ${height} with ${count} sections renders ` +
          `${menuRows(menu, count)} rows`,
      );
    }
  }
});

test("list window follows the cursor and clamps at the ends", () => {
  assert.deepEqual(computeListWindow(0, 12, 6), {
    start: 0,
    hiddenAbove: 0,
    hiddenBelow: 6,
  });
  assert.deepEqual(computeListWindow(6, 12, 6), {
    start: 4,
    hiddenAbove: 4,
    hiddenBelow: 2,
  });
  assert.deepEqual(computeListWindow(11, 12, 6), {
    start: 6,
    hiddenAbove: 6,
    hiddenBelow: 0,
  });
});

test("lists that fit are never windowed", () => {
  assert.deepEqual(computeListWindow(3, 5, 8), {
    start: 0,
    hiddenAbove: 0,
    hiddenBelow: 0,
  });
});
