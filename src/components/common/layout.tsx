// Ink-side plumbing for the fixed-viewport wizard: terminal size tracking,
// the layout context that sizes step boxes and lists, the alternate-screen
// render wrapper, and a keyboard-scrollable region for oversized content.

import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Box,
  measureElement,
  render,
  Text,
  useStdout,
  type DOMElement,
} from "ink";
import { computeLayout, type WizardLayout } from "../../lib/layout.js";
import { useGatedInput } from "./CommandApproval.js";

export interface ViewportSize {
  rows: number;
  columns: number;
}

/** Current terminal size, updated live on resize. */
export function useViewport(): ViewportSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<ViewportSize>({
    rows: stdout.rows || 24,
    columns: stdout.columns || 80,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

export interface StepLayout extends WizardLayout {
  /**
   * True once a BorderBox has applied the fixed step-box height, so any
   * BorderBox nested inside it falls back to natural content sizing.
   */
  frameClaimed: boolean;
}

export const StepLayoutContext = createContext<StepLayout | null>(null);

/** The wizard's fixed layout, or null outside the WizardShell. */
export function useStepLayout(): StepLayout | null {
  return useContext(StepLayoutContext);
}

const ENTER_ALT_SCREEN = "\x1B[?1049h\x1B[H";
const LEAVE_ALT_SCREEN = "\x1B[?1049l";

/**
 * Render an Ink app on the terminal's alternate screen buffer (like vim or
 * htop): the app owns the window while running, nothing it draws can leak
 * into scrollback, and the previous terminal contents are restored on exit.
 * Restoration is guaranteed on unmount, Ctrl+C, and process exit.
 */
export async function renderFullScreen(
  element: React.ReactElement,
): Promise<void> {
  const stdout = process.stdout;
  if (!stdout.isTTY) {
    const { waitUntilExit } = render(element);
    await waitUntilExit();
    return;
  }

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(LEAVE_ALT_SCREEN);
  };

  stdout.write(ENTER_ALT_SCREEN);
  process.on("exit", restore);
  try {
    const { waitUntilExit } = render(element);
    await waitUntilExit();
  } finally {
    restore();
    process.removeListener("exit", restore);
  }
}

interface ScrollAreaProps {
  /** Total rows the component occupies (viewport plus its status row). */
  height: number;
  /** Disable the ↑/↓ handlers when another control owns the arrow keys. */
  isActive?: boolean;
  children: ReactNode;
}

/**
 * Fixed-height region whose content scrolls with ↑/↓ and PgUp/PgDn when it
 * does not fit. Content that fits renders as-is with no chrome.
 */
export function ScrollArea({
  height,
  isActive = true,
  children,
}: ScrollAreaProps) {
  const [offset, setOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const innerRef = useRef<DOMElement>(null);

  useEffect(() => {
    if (innerRef.current) {
      const measured = measureElement(innerRef.current).height;
      if (measured !== contentHeight) {
        setContentHeight(measured);
      }
    }
  });

  const scrollable = contentHeight > height;
  // One row is reserved for the scroll status line when scrolling is needed.
  const viewportHeight = scrollable ? Math.max(1, height - 1) : height;
  const maxOffset = Math.max(0, contentHeight - viewportHeight);
  const clampedOffset = Math.min(offset, maxOffset);

  useGatedInput(
    (_input, key) => {
      if (!scrollable) return;
      if (key.upArrow) {
        setOffset(Math.max(0, clampedOffset - 1));
      } else if (key.downArrow) {
        setOffset(Math.min(maxOffset, clampedOffset + 1));
      } else if (key.pageUp) {
        setOffset(Math.max(0, clampedOffset - viewportHeight));
      } else if (key.pageDown) {
        setOffset(Math.min(maxOffset, clampedOffset + viewportHeight));
      }
    },
    { isActive },
  );

  const moreAbove = clampedOffset > 0;
  const moreBelow = clampedOffset < maxOffset;

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={viewportHeight} overflowY="hidden">
        <Box
          ref={innerRef}
          flexDirection="column"
          flexShrink={0}
          marginTop={-clampedOffset}
        >
          {children}
        </Box>
      </Box>
      {scrollable && (
        <Text color="gray" dimColor>
          {moreAbove ? "▲" : " "} ↑/↓ to scroll{" "}
          {moreBelow
            ? `• ${contentHeight - clampedOffset - viewportHeight} more below ▼`
            : "• end"}
        </Text>
      )}
    </Box>
  );
}
