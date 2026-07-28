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
import { useStepLayout } from "./layout.js";
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
  const layout = useStepLayout();
  const maxRows = layout?.listLimit ?? 8;
  const resolvedIndex = Math.min(
    Math.max(
      initialIndex ??
        Math.max(
          0,
          items.findIndex((item) => item.value === initialValue),
        ),
      0,
    ),
    Math.max(items.length - 1, 0),
  );
  // Lists take exactly the rows they need; scrolling kicks in only when the
  // item count exceeds what the layout allows (no reserved blank rows).
  const limit = Math.min(items.length, maxRows);
  const scrolls = items.length > limit;
  const [highlighted, setHighlighted] = useState(resolvedIndex);

  return (
    <Box flexDirection="column" marginY={1}>
      <FieldHeader label={label} hint={hint} />
      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={items}
          onSelect={(item: SelectOption) => onSelect(item.value)}
          onHighlight={(item: SelectOption) =>
            setHighlighted(items.findIndex((i) => i.value === item.value))
          }
          initialIndex={resolvedIndex}
          limit={scrolls ? limit : undefined}
          indicatorComponent={() => null}
          itemComponent={({ isSelected, label: itemLabel }) => (
            <Text
              color={isSelected ? colors.accent : undefined}
              wrap="truncate-end"
            >
              {isSelected ? "❯ " : "  "}
              {itemLabel}
            </Text>
          )}
        />
      </Box>
      {scrolls && (
        <Text color={colors.muted} dimColor>
          ↑/↓ to scroll • {Math.max(highlighted, 0) + 1}/{items.length}
        </Text>
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
   * Preselect the recommendation over initialValue when both resolve. Set on
   * fresh-init pickers whose initialValue is only profile memory from
   * previous deployments; configure-mode pickers keep the default (the
   * deployment's saved value wins).
   */
  preferRecommended?: boolean;
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
  preferRecommended = false,
  noRecommendationNotice,
}: DiscoveredSelectProps) {
  const { colors } = useTheme();
  const layout = useStepLayout();
  const [items, setItems] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [highlighted, setHighlighted] = useState(0);

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
  const maxRows = layout?.listLimit ?? 8;
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
  const rankedIndexes = preferRecommended
    ? [recommended, savedIndex]
    : [savedIndex, recommended];
  const preselect =
    rankedIndexes.find((index) => index >= 0) ??
    (showNoRecommendation ? items.length : 0);
  const listItems: SelectOption[] = [
    ...items.map((item, index) => ({
      label:
        index === recommended ? `${item.label}  - recommended` : item.label,
      value: item.value,
    })),
    { label: manualLabel, value: MANUAL },
  ];
  // Size the list to its contents; scroll only past the layout's budget
  // instead of reserving a fixed block of rows.
  const limit = Math.min(listItems.length, maxRows);
  const scrolls = listItems.length > limit;

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
      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={listItems}
          onSelect={(item: SelectOption) => {
            if (item.value === MANUAL) onManual();
            else onSelect(item.value);
          }}
          onHighlight={(item: SelectOption) =>
            setHighlighted(
              listItems.findIndex((i) => i.value === item.value),
            )
          }
          limit={scrolls ? limit : undefined}
          initialIndex={preselect}
          indicatorComponent={() => null}
          itemComponent={({ isSelected, label: itemLabel }) => (
            <Text
              color={isSelected ? colors.accent : undefined}
              wrap="truncate-end"
            >
              {isSelected ? "❯ " : "  "}
              {itemLabel}
            </Text>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          R to refresh • ↑/↓ to navigate • Enter to select
          {scrolls
            ? ` • ${Math.max(highlighted, 0) + 1}/${listItems.length}`
            : ""}
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

/** Most completed-setting rows shown before older ones collapse. */
const MAX_CHECK_ROWS = 5;

export function CheckRows({ rows }: { rows: CheckRow[] }) {
  const { colors } = useTheme();
  if (rows.length === 0) return null;
  // Cap the block so accumulating checkmarks can't blow the fixed step-box
  // budget; the most recent settings are the relevant ones.
  const collapsed = Math.max(0, rows.length - (MAX_CHECK_ROWS - 1));
  const visible = collapsed > 0 ? rows.slice(collapsed) : rows;
  return (
    <Box marginTop={1} flexDirection="column">
      {collapsed > 0 && (
        <Text color="gray" dimColor>
          {"  "}… {collapsed} earlier setting{collapsed === 1 ? "" : "s"}
        </Text>
      )}
      {visible.map((row) => (
        <Box key={row.label}>
          <Text color={colors.success}>{"✓"}</Text>
          <Text color="gray" wrap="truncate-end">
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
