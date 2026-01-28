import React, { createContext, useContext, ReactNode } from "react";

/**
 * Command theme types - each command has its own visual identity
 */
export type CommandTheme =
  | "init"
  | "deploy"
  | "upgrade"
  | "destroy"
  | "status"
  | "logs";

/**
 * Theme color configuration
 */
export interface ThemeColors {
  /** Primary accent color for borders, highlights */
  accent: string;
  /** Brighter variant for emphasis */
  accentBright: string;
  /** Color for selected/active items */
  selected: string;
  /** Color for success states */
  success: string;
  /** Color for error states */
  error: string;
  /** Color for warning states */
  warning: string;
  /** Dimmed/muted color */
  muted: string;
}

/**
 * Theme definitions for each command
 *
 * - init: Magenta - fresh start, creative setup
 * - deploy: Blue - action, progress, trust
 * - upgrade: #ea9d34 - caution, change, attention
 * - destroy: Red - danger, destructive action
 * - status: #4c9c81 - health, success, information
 * - logs: #c2b5ab - neutral, observational
 */
export const THEMES: Record<CommandTheme, ThemeColors> = {
  init: {
    accent: "#c4a7e7",
    accentBright: "#a78bc7",
    selected: "#c4a7e7",
    success: "#4c9c81",
    error: "#d7827e",
    warning: "#ea9d34",
    muted: "#c2b5ab",
  },
  deploy: {
    accent: "#64a5b0",
    accentBright: "#5fbac9",
    selected: "#64a5b0",
    success: "#4c9c81",
    error: "#d7827e",
    warning: "#ea9d34",
    muted: "#c2b5ab",
  },
  upgrade: {
    accent: "#3e8fb0",
    accentBright: "#5aabcc",
    selected: "#3e8fb0",
    success: "#4c9c81",
    error: "#d7827e",
    warning: "#ea9d34",
    muted: "#c2b5ab",
  },
  destroy: {
    accent: "#d7827e",
    accentBright: "#ea9a97",
    selected: "#d7827e",
    success: "#4c9c81",
    error: "#d7827e",
    warning: "#cf6d69",
    muted: "#a18581",
  },
  status: {
    accent: "#4c9c81",
    accentBright: "#4c9c81",
    selected: "#4c9c81",
    success: "#4c9c81",
    error: "#d7827e",
    warning: "#ea9d34",
    muted: "#c2b5ab",
  },
  logs: {
    accent: "#524f67",
    accentBright: "#56526e",
    selected: "#cecacd",
    success: "#4c9c81",
    error: "#d7827e",
    warning: "#ea9d34",
    muted: "#c2b5ab",
  },
};

/**
 * Default theme (used when no provider is present)
 */
export const DEFAULT_THEME: CommandTheme = "init";

/**
 * Theme context value
 */
interface ThemeContextValue {
  theme: CommandTheme;
  colors: ThemeColors;
}

/**
 * Theme context - provides current theme to all child components
 */
const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  colors: THEMES[DEFAULT_THEME],
});

/**
 * ThemeProvider props
 */
interface ThemeProviderProps {
  theme: CommandTheme;
  children: ReactNode;
}

/**
 * ThemeProvider component - wraps a command to provide themed styling
 *
 * @example
 * ```tsx
 * <ThemeProvider theme="destroy">
 *   <DestroyCommand />
 * </ThemeProvider>
 * ```
 */
export function ThemeProvider({
  theme,
  children,
}: ThemeProviderProps): React.ReactElement {
  const value: ThemeContextValue = {
    theme,
    colors: THEMES[theme],
  };

  return React.createElement(ThemeContext.Provider, { value }, children);
}

/**
 * Hook to access current theme colors
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { colors } = useTheme();
 *   return <Text color={colors.accent}>Themed text</Text>;
 * }
 * ```
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Get theme colors directly without hook (for non-component code)
 */
export function getThemeColors(theme: CommandTheme): ThemeColors {
  return THEMES[theme];
}
