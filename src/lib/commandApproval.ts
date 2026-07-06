import { CloudProvider } from "../types/index.js";
import {
  addApprovedCommandIntent,
  loadApprovedCommandIntents,
} from "./config.js";

export type CommandApprovalDecision = "approve" | "deny";
export type CommandApprovalScope = "once" | "all-like" | "all";

export interface CommandApprovalRequest {
  intent: string;
  command: string;
  description?: string;
  provider?: CloudProvider;
  mutating?: boolean;
}

export interface PendingCommandApproval extends CommandApprovalRequest {
  id: number;
}

type Resolver = (decision: CommandApprovalDecision) => void;
type Listener = () => void;

interface QueuedApproval extends PendingCommandApproval {
  resolvers: Resolver[];
}

export class CommandDeniedError extends Error {
  readonly command: string;
  readonly intent: string;

  constructor(command: string, intent: string) {
    super(`User denied cloud CLI command: ${command}`);
    this.name = "CommandDeniedError";
    this.command = command;
    this.intent = intent;
  }
}

let nextId = 1;
let interactive = false;
let approveAll = false;
const approvedIntents = new Set<string>();
const queue: QueuedApproval[] = [];
const inFlightByCommand = new Map<string, QueuedApproval>();
const listeners = new Set<Listener>();
let current: QueuedApproval | null = null;
let hydration: Promise<void> | null = null;

// Loads intents the user previously approved with "Approve all" from the
// profile, once per process, before the first prompt decision. Session-only
// scopes ("once", "all") are never persisted.
function ensureHydrated(): Promise<void> {
  if (!hydration) {
    hydration = loadApprovedCommandIntents()
      .then((intents) => {
        for (const intent of intents) {
          approvedIntents.add(intent);
        }
      })
      .catch(() => {
        // A missing or unreadable profile just means we prompt as usual.
      });
  }
  return hydration;
}

function isTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function shouldPrompt(req: CommandApprovalRequest): boolean {
  if (!interactive || !isTty()) return false;
  if (approveAll || approvedIntents.has(req.intent)) return false;
  return true;
}

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function pumpQueue() {
  if (current || queue.length === 0) return;
  current = queue.shift() || null;
  notify();
}

function complete(
  approval: QueuedApproval,
  decision: CommandApprovalDecision,
) {
  inFlightByCommand.delete(approval.command);
  for (const resolve of approval.resolvers) {
    resolve(decision);
  }
}

function completeQueuedByIntent(intent: string) {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const approval = queue[i];
    if (approval.intent !== intent) continue;
    queue.splice(i, 1);
    complete(approval, "approve");
  }
}

export function setCommandApprovalInteractive(value: boolean) {
  interactive = value;
}

export function subscribeCommandApprovals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCurrentCommandApproval(): PendingCommandApproval | null {
  if (!current) return null;
  const { resolvers: _resolvers, ...pending } = current;
  return pending;
}

export function respondToCommandApproval(
  id: number,
  decision: CommandApprovalDecision,
  scope: CommandApprovalScope = "once",
) {
  if (!current || current.id !== id) return;

  const approval = current;
  current = null;

  if (decision === "approve") {
    if (scope === "all") {
      approveAll = true;
    } else if (scope === "all-like") {
      approvedIntents.add(approval.intent);
      completeQueuedByIntent(approval.intent);
      // Remember the blanket approval across CLI runs. Best-effort: a failed
      // write only means the user is asked again next run.
      void addApprovedCommandIntent(approval.intent).catch(() => {});
    }
  }

  complete(approval, decision);
  notify();
  pumpQueue();
}

export async function requestCommandApproval(
  req: CommandApprovalRequest,
): Promise<CommandApprovalDecision> {
  if (interactive && isTty()) {
    await ensureHydrated();
  }
  if (!shouldPrompt(req)) {
    return "approve";
  }

  const existing = inFlightByCommand.get(req.command);
  if (existing) {
    return new Promise((resolve) => {
      existing.resolvers.push(resolve);
    });
  }

  return new Promise((resolve) => {
    const approval: QueuedApproval = {
      id: nextId++,
      ...req,
      resolvers: [resolve],
    };
    inFlightByCommand.set(req.command, approval);
    queue.push(approval);
    pumpQueue();
  });
}

export async function approveCloudCommandOrThrow(
  req: CommandApprovalRequest,
): Promise<void> {
  const decision = await requestCommandApproval(req);
  if (decision === "deny") {
    throw new CommandDeniedError(req.command, req.intent);
  }
}
