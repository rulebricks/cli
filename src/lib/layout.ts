// Pure layout math for the fixed-viewport wizard TUI. The wizard renders on
// the terminal's alternate screen buffer with a constant-height frame; this
// module decides what fits. Kept free of Ink imports so node:test can cover
// the size matrix directly.

/** Rows used by the logo block: 1 top margin + 8 art lines + 1 bottom gap. */
export const LOGO_BLOCK_ROWS = 10;

/** Outer frame chrome: top border + bottom border + paddingY (1 each side). */
export const FRAME_CHROME_ROWS = 4;

/** Header slot: step line + gap + progress bar + trailing gap. */
export const HEADER_ROWS_FULL = 4;

/** Compact header slot: step line + trailing gap (progress bar dropped). */
export const HEADER_ROWS_COMPACT = 2;

/** The step box never grows past this, even on very tall terminals. */
export const MAX_STEP_BOX_ROWS = 20;

/** Below this the step box cannot hold a field plus its chrome. */
export const MIN_STEP_BOX_ROWS = 12;

/** Preferred step box height before we start dropping chrome. */
const COMFORTABLE_STEP_BOX_ROWS = 14;

/** Default dialog widths, shrunk on narrow terminals. */
const FRAME_WIDTH = 70;
const STEP_BOX_WIDTH = 60;

/** Columns consumed left of the frame (paddingLeft) plus a safety column. */
const FRAME_LEFT_MARGIN_COLS = 3;

/** Rows of non-list content around a select inside the step box: borders,
 * description, field label + hint, margins, per-field hint line, a completed
 * row or two. Lists get whatever remains. */
const LIST_OVERHEAD_ROWS = 12;

export const MIN_LIST_ROWS = 3;
export const MAX_LIST_ROWS = 8;

export interface WizardLayout {
  /** Terminal is too short/narrow to render the wizard at all. */
  tooSmall: boolean;
  /** Render the ASCII logo block above the frame. */
  showLogo: boolean;
  /** Render the progress bar row (dropped on short terminals). */
  showProgressBar: boolean;
  /** Rows reserved for the header slot inside the frame. */
  headerRows: number;
  /** Total width of the outer frame including its borders. */
  frameWidth: number;
  /** Total width of the per-step inner box including its borders. */
  stepBoxWidth: number;
  /** Total height of the per-step inner box including its borders. */
  stepBoxHeight: number;
  /** Max visible rows for scrolling select lists inside the step box. */
  listLimit: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute the fixed wizard layout for a terminal size. The total rendered
 * height is guaranteed to be at most `rows`, so Ink never has to scroll the
 * viewport (which is what used to push the logo off screen and leak frames
 * into scrollback).
 */
export function computeLayout(rows: number, columns: number): WizardLayout {
  // Ink falls back to clearing and rewriting the whole terminal on every
  // frame once output height reaches the row count; stay strictly below it.
  const usableRows = rows - 1;
  const frameWidth = Math.min(FRAME_WIDTH, columns - FRAME_LEFT_MARGIN_COLS);
  // Frame content sits inside paddingX(2) on both sides.
  const stepBoxWidth = Math.min(STEP_BOX_WIDTH, frameWidth - 4);

  const layout = (
    showLogo: boolean,
    showProgressBar: boolean,
    stepBoxHeight: number,
  ): WizardLayout => ({
    tooSmall: false,
    showLogo,
    showProgressBar,
    headerRows: showProgressBar ? HEADER_ROWS_FULL : HEADER_ROWS_COMPACT,
    frameWidth,
    stepBoxWidth,
    stepBoxHeight,
    listLimit: clamp(
      stepBoxHeight - LIST_OVERHEAD_ROWS,
      MIN_LIST_ROWS,
      MAX_LIST_ROWS,
    ),
  });

  if (stepBoxWidth < 40) {
    return { ...layout(false, false, MIN_STEP_BOX_ROWS), tooSmall: true };
  }

  // Degradation ladder: full chrome, then drop the logo, then the progress
  // bar. Each rung is used only if it leaves a workable step box.
  const withLogo =
    usableRows - LOGO_BLOCK_ROWS - FRAME_CHROME_ROWS - HEADER_ROWS_FULL;
  if (withLogo >= COMFORTABLE_STEP_BOX_ROWS) {
    return layout(true, true, Math.min(withLogo, MAX_STEP_BOX_ROWS));
  }

  const withoutLogo = usableRows - FRAME_CHROME_ROWS - HEADER_ROWS_FULL;
  if (withoutLogo >= COMFORTABLE_STEP_BOX_ROWS) {
    return layout(false, true, Math.min(withoutLogo, MAX_STEP_BOX_ROWS));
  }

  const compact = usableRows - FRAME_CHROME_ROWS - HEADER_ROWS_COMPACT;
  if (compact >= MIN_STEP_BOX_ROWS) {
    return layout(false, false, Math.min(compact, MAX_STEP_BOX_ROWS));
  }

  return { ...layout(false, false, MIN_STEP_BOX_ROWS), tooSmall: true };
}
