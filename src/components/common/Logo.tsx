import React, { useState } from "react";
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

// Static output persists in the terminal even after the component unmounts.
// If a command swaps root components (e.g. configure's loading screen being
// replaced by the wizard), a remounted Logo would create a new Static
// instance and print the logo a second time. Guard per process instead.
let hasPrintedLogo = false;

/**
 * Logo component that renders the ASCII art logo once per process using
 * Ink's Static. Static ensures the logo stays at the top of the output
 * without re-rendering when other components update.
 */
export function Logo() {
  const { colors } = useTheme();
  const [shouldPrint] = useState(() => {
    if (hasPrintedLogo) return false;
    hasPrintedLogo = true;
    return true;
  });

  if (!shouldPrint) return null;

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
