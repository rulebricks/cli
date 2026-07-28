import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLayout,
  FRAME_CHROME_ROWS,
  HEADER_ROWS_COMPACT,
  HEADER_ROWS_FULL,
  LOGO_BLOCK_ROWS,
  MAX_LIST_ROWS,
  MAX_STEP_BOX_ROWS,
  MIN_LIST_ROWS,
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
