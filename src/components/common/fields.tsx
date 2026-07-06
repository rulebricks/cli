// Shared prompt components used by every wizard step: a select list, a text
// input, a cloud-discovered select with refresh and manual entry, a checkbox
// list, and small summary/error/footer helpers. Keeping the rendering here
// keeps prompts visually and behaviorally identical across steps.

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { Spinner } from "./Spinner.js";
import { useGatedInput } from "./CommandApproval.js";
import { useTheme } from "../../lib/theme.js";

/** Sentinel select value that drops the user into manual text entry. */
export const MANUAL = "__manual__";

export interface SelectOption {
  label: string;
  value: string;
}

interface FieldHeaderProps {
  label: string;
  hint?: string;
}

function FieldHeader({ label, hint }: FieldHeaderProps) {
  return (
    <>
      <Text bold>{label}</Text>
      {hint && (
        <Text color="gray" dimColor>
          {hint}
        </Text>
      )}
    </>
  );
}

export interface WizardSelectProps {
  label: string;
  hint?: string;
  items: SelectOption[];
  onSelect: (value: string) => void;
  /** Preselect the item with this value when present. */
  initialValue?: string;
  /** Explicit preselect index; overrides initialValue. */
  initialIndex?: number;
  footer?: string;
}

export function WizardSelect({
  label,
  hint,
  items,
  onSelect,
  initialValue,
  initialIndex,
  footer,
}: WizardSelectProps) {
  const { colors } = useTheme();
  const resolvedIndex =
    initialIndex ??
    Math.max(
      0,
      items.findIndex((item) => item.value === initialValue),
    );
  const scrolls = items.length > 8;

  const list = (
    <SelectInput
      items={items}
      onSelect={(item: SelectOption) => onSelect(item.value)}
      initialIndex={Math.min(Math.max(resolvedIndex, 0), items.length - 1)}
      limit={scrolls ? 8 : undefined}
      indicatorComponent={() => null}
      itemComponent={({ isSelected, label: itemLabel }) => (
        <Text color={isSelected ? colors.accent : undefined}>
          {isSelected ? "❯ " : "  "}
          {itemLabel}
        </Text>
      )}
    />
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <FieldHeader label={label} hint={hint} />
      {scrolls ? (
        <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
          {list}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {list}
        </Box>
      )}
      {footer && (
        <Text color={colors.muted} dimColor>
          {footer}
        </Text>
      )}
    </Box>
  );
}

export interface TextFieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  mask?: boolean;
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  onSubmit,
  placeholder,
  mask,
}: TextFieldProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <FieldHeader label={label} hint={hint} />
      <Box marginTop={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          mask={mask ? "*" : undefined}
        />
      </Box>
    </Box>
  );
}

export interface DiscoveredSelectProps {
  label: string;
  hint?: string;
  /** Lists candidates through a cloud CLI; runs on mount and on R. */
  load: () => Promise<SelectOption[]>;
  loadingLabel: string;
  /** Shown above the list when discovery returns nothing. */
  emptyHint: string;
  onSelect: (value: string) => void;
  onManual: () => void;
  manualLabel?: string;
  /** Index of the recommended item (-1 for none); it is preselected and labeled. */
  recommendIndex?: (items: SelectOption[]) => number;
  /** Preselect the item with this value when present (used after recommendIndex). */
  initialValue?: string;
  /**
   * Shown above the list when recommendIndex finds no match and there is no
   * saved value, so the cursor landing on the first item is never mistaken
   * for a recommendation (e.g. the expected cluster-setup resource is absent).
   */
  noRecommendationNotice?: string;
}

export function DiscoveredSelect({
  label,
  hint,
  load,
  loadingLabel,
  emptyHint,
  onSelect,
  onManual,
  manualLabel = "Enter manually…",
  recommendIndex,
  initialValue,
  noRecommendationNotice,
}: DiscoveredSelectProps) {
  const { colors } = useTheme();
  const [items, setItems] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(true);

  const runLoad = async () => {
    setLoading(true);
    try {
      setItems(await load());
    } catch {
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    runLoad();
  }, []);

  useGatedInput((input) => {
    if (!loading && input.toLowerCase() === "r") {
      runLoad();
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Spinner label={loadingLabel} />
      </Box>
    );
  }

  const recommended = recommendIndex ? recommendIndex(items) : -1;
  const savedIndex = initialValue
    ? items.findIndex((item) => item.value === initialValue)
    : -1;
  const showNoRecommendation =
    noRecommendationNotice !== undefined &&
    recommendIndex !== undefined &&
    items.length > 0 &&
    recommended < 0 &&
    savedIndex < 0;
  // Without a recommendation or saved value, pickers that declared a notice
  // land on manual entry: silently preselecting an arbitrary first item is how
  // infrastructure roles end up bound to workloads.
  const preselect =
    savedIndex >= 0
      ? savedIndex
      : recommended >= 0
        ? recommended
        : showNoRecommendation
          ? items.length
          : 0;
  const listItems: SelectOption[] = [
    ...items.map((item, index) => ({
      label:
        index === recommended ? `${item.label}  - recommended` : item.label,
      value: item.value,
    })),
    { label: manualLabel, value: MANUAL },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <FieldHeader label={label} hint={hint} />
      {items.length === 0 && (
        <Box marginTop={1}>
          <Text color="yellow">{emptyHint}</Text>
        </Box>
      )}
      {showNoRecommendation && (
        <Box marginTop={1}>
          <Text color="yellow">{noRecommendationNotice}</Text>
        </Box>
      )}
      <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
        <SelectInput
          items={listItems}
          onSelect={(item: SelectOption) => {
            if (item.value === MANUAL) onManual();
            else onSelect(item.value);
          }}
          limit={8}
          initialIndex={preselect}
          indicatorComponent={() => null}
          itemComponent={({ isSelected, label: itemLabel }) => (
            <Text color={isSelected ? colors.accent : undefined}>
              {isSelected ? "❯ " : "  "}
              {itemLabel}
            </Text>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          R to refresh • ↑/↓ to navigate • Enter to select
        </Text>
      </Box>
    </Box>
  );
}

export interface CheckboxItem {
  key: string;
  label: string;
  hint?: string;
  checked: boolean;
}

export interface CheckboxListProps {
  label: string;
  hint?: string;
  items: CheckboxItem[];
  onToggle: (key: string) => void;
  onContinue: () => void;
}

export function CheckboxList({
  label,
  hint,
  items,
  onToggle,
  onContinue,
}: CheckboxListProps) {
  const { colors } = useTheme();
  const [cursor, setCursor] = useState(0);

  useGatedInput((input, key) => {
    if (key.upArrow) {
      setCursor((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setCursor((i) => Math.min(items.length, i + 1));
    } else if (input === " " || input.toLowerCase() === "x") {
      if (cursor < items.length) onToggle(items[cursor].key);
    } else if (key.return) {
      if (cursor === items.length) onContinue();
      else onToggle(items[cursor].key);
    }
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <FieldHeader
        label={label}
        hint={hint ?? "Space/Enter to toggle • ↑/↓ to navigate"}
      />
      <Box marginTop={1} flexDirection="column">
        {items.map((item, index) => {
          const selected = index === cursor;
          return (
            <Box key={item.key} flexDirection="column">
              <Box>
                <Text color={selected ? colors.accent : undefined}>
                  {selected ? "❯ " : "  "}
                </Text>
                <Text color={item.checked ? colors.success : colors.muted}>
                  {item.checked ? "[✓]" : "[ ]"}
                </Text>
                <Text color={selected ? colors.accent : undefined}>
                  {" "}
                  {item.label}
                </Text>
              </Box>
              {selected && item.hint && (
                <Box marginLeft={6}>
                  <Text color="gray" dimColor>
                    {item.hint}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={cursor === items.length ? colors.accent : colors.muted}>
            {cursor === items.length ? "❯ " : "  "}
          </Text>
          <Text
            color={cursor === items.length ? colors.success : colors.muted}
            bold={cursor === items.length}
          >
            [Continue →]
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export interface CheckRow {
  label: string;
  value?: string;
}

export function CheckRows({ rows }: { rows: CheckRow[] }) {
  const { colors } = useTheme();
  if (rows.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      {rows.map((row) => (
        <Box key={row.label}>
          <Text color={colors.success}>{"✓"}</Text>
          <Text color="gray">
            {" "}
            {row.label}
            {row.value ? `: ${row.value}` : ""}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function FieldError({ error }: { error: string | null }) {
  const { colors } = useTheme();
  if (!error) return null;
  return (
    <Box marginTop={1}>
      <Text color={colors.error}>{"✗"} {error}</Text>
    </Box>
  );
}

export function StepFooter({ hints }: { hints?: string[] }) {
  return (
    <Box marginTop={1}>
      <Text color="gray" dimColor>
        {(hints ?? ["Esc to go back", "Enter to continue"]).join(" • ")}
      </Text>
    </Box>
  );
}
