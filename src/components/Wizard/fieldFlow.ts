// Declarative sub-step sequencing for wizard steps.
//
// A step declares its prompts as an ordered list of fields, each with an
// optional `when` visibility predicate. The flow hook resolves forward and
// back navigation against that single list, so both directions always agree,
// conditional fields appear and disappear symmetrically, and resuming at the
// end of a step (back-entry from a later wizard step) needs no per-step logic.
//
// Navigation is deferred to an effect so predicates always evaluate against
// the state committed by the handler that requested the move.

import {
  createElement,
  Fragment,
  ReactNode,
  useEffect,
  useState,
} from "react";
import { useGatedInput } from "../common/index.js";

export interface FlowController {
  current: string;
  next: () => void;
  back: () => void;
  goTo: (id: string) => void;
}

export interface FlowField {
  id: string;
  when?: () => boolean;
  render: (flow: FlowController) => ReactNode;
  /**
   * Runs when Escape is pressed while this field is current, before the back
   * target is resolved. Lets alternate-mode fields (manual entry reached from
   * a picker) reset their mode flag so back lands on the picker they came
   * from instead of skipping past it.
   */
  onEscape?: () => void;
}

export function isFieldVisible(field: FlowField): boolean {
  return field.when ? field.when() !== false : true;
}

export function visibleFieldIds(fields: FlowField[]): string[] {
  return fields.filter(isFieldVisible).map((field) => field.id);
}

export function firstVisibleFieldId(fields: FlowField[]): string | undefined {
  return fields.find(isFieldVisible)?.id;
}

export function lastVisibleFieldId(fields: FlowField[]): string | undefined {
  for (let i = fields.length - 1; i >= 0; i--) {
    if (isFieldVisible(fields[i])) return fields[i].id;
  }
  return undefined;
}

export function nextVisibleFieldId(
  fields: FlowField[],
  currentId: string,
): string | undefined {
  const position = fields.findIndex((field) => field.id === currentId);
  return fields.slice(position + 1).find(isFieldVisible)?.id;
}

export function prevVisibleFieldId(
  fields: FlowField[],
  currentId: string,
): string | undefined {
  const position = fields.findIndex((field) => field.id === currentId);
  if (position <= 0) return undefined;
  for (let i = position - 1; i >= 0; i--) {
    if (isFieldVisible(fields[i])) return fields[i].id;
  }
  return undefined;
}

type PendingNav =
  | { kind: "next" }
  | { kind: "back" }
  | { kind: "goto"; id: string }
  | null;

export interface UseFieldFlowOptions {
  fields: FlowField[];
  /** Called when advancing past the last visible field. */
  onDone: () => void;
  /** Called when backing out of the first visible field. */
  onExit: () => void;
  /** "end" resumes at the last visible field. */
  entry?: "start" | "end";
  /** When true (default), Escape triggers back navigation. */
  escapeGoesBack?: boolean;
  /** Reset transient state (e.g. error messages) on any navigation. */
  onNavigate?: () => void;
}

export interface FieldFlow extends FlowController {
  field: FlowField | undefined;
  /**
   * Renders the current field keyed by its id. Steps must use this (rather
   * than calling `field.render` directly) so that moving between two fields
   * that render the same component type (e.g. DiscoveredSelect →
   * DiscoveredSelect, or TextField → TextField) remounts the component.
   * Without the key, React reconciles them in place and mount-time state
   * leaks across fields: discovered lists never reload (a bucket picker keeps
   * showing regions) and the text cursor keeps its previous offset (landing
   * mid-string in pre-populated inputs).
   */
  render: () => ReactNode;
}

export function useFieldFlow({
  fields,
  onDone,
  onExit,
  entry = "start",
  escapeGoesBack = true,
  onNavigate,
}: UseFieldFlowOptions): FieldFlow {
  const [current, setCurrent] = useState<string>(() => {
    const id =
      entry === "end" ? lastVisibleFieldId(fields) : firstVisibleFieldId(fields);
    return id ?? fields[0]?.id ?? "";
  });
  const [pending, setPending] = useState<PendingNav>(null);

  useEffect(() => {
    if (!pending) return;
    setPending(null);
    onNavigate?.();

    if (pending.kind === "goto") {
      setCurrent(pending.id);
      return;
    }
    if (pending.kind === "next") {
      const target = nextVisibleFieldId(fields, current);
      if (target) setCurrent(target);
      else onDone();
      return;
    }
    const target = prevVisibleFieldId(fields, current);
    if (target) setCurrent(target);
    else onExit();
  }, [pending]);

  useGatedInput(
    (_input, key) => {
      if (key.escape) {
        // Both updates batch, so the back target is resolved against the
        // visibility produced by onEscape (e.g. a picker made visible again).
        fields.find((field) => field.id === current)?.onEscape?.();
        setPending({ kind: "back" });
      }
    },
    { isActive: escapeGoesBack },
  );

  const flow: FieldFlow = {
    current,
    field: fields.find((field) => field.id === current),
    next: () => setPending({ kind: "next" }),
    back: () => setPending({ kind: "back" }),
    goTo: (id: string) => setPending({ kind: "goto", id }),
    render: () =>
      createElement(
        Fragment,
        { key: current },
        flow.field ? flow.field.render(flow) : null,
      ),
  };
  return flow;
}
