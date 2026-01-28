import React from "react";
import { Box, Text, Static } from "ink";
import { useTheme } from "../../lib/theme.js";

export const LOGO_LINES = [
  "           ⟋ ‾‾‾‾⟋|",
  "          ██████  |",
  "          ██████  |",
  "          ██████ ⟋ ‾‾‾‾⟋|",
  "        ⟋     ⟋ ██████  |",
  "       ██████   ██████  |",
  "       ██████   ██████⟋",
  "       ██████⟋",
];

/**
 * Logo component that renders the ASCII art logo once using Ink's Static.
 * Static ensures the logo is rendered exactly once and stays at the top
 * of the output, without re-rendering when other components update.
 */
export function Logo() {
  const { colors } = useTheme();

  return (
    <Static items={["logo"]}>
      {(item) => (
        <Box key={item} flexDirection="column" marginTop={1} marginBottom={2}>
          {LOGO_LINES.map((line, i) => (
            <Text key={i} color={colors.accent}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Static>
  );
}
