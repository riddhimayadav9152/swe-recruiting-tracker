// Centralized policy for which workflow actions are allowed from a given
// application status. Both the API route (server-side enforcement) and the
// UI (which buttons to show) read from this same matrix, so the two can
// never drift apart.

export const TERMINAL_STATUSES = ['Accepted', 'Rejected', 'Withdrawn', 'Closed'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const isTerminalStatus = (status: string): status is TerminalStatus =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

// Actions that change (or attempt to change) an application's status/stage.
// Note, contact, and job-description edits are informational and are always
// allowed regardless of status, so they aren't part of this list.
export type TransitionAction =
  | 'apply'
  | 'oaReceived'
  | 'oaCompleted'
  | 'interviewReceived'
  | 'interviewCompleted'
  | 'reject'
  | 'offer';

const TRANSITION_MATRIX: Record<string, TransitionAction[] | undefined> = {
  'Not Applied': ['apply', 'reject'],
  Preparing: ['apply', 'reject'],
  Applied: ['oaReceived', 'interviewReceived', 'offer', 'reject'],
  OA: ['oaReceived', 'oaCompleted', 'interviewReceived', 'offer', 'reject'],
  'Recruiter Screen': ['interviewReceived', 'interviewCompleted', 'offer', 'reject'],
  'Technical Interview': ['interviewReceived', 'interviewCompleted', 'offer', 'reject'],
  'Final Round': ['interviewReceived', 'interviewCompleted', 'offer', 'reject'],
  Offer: ['offer', 'reject'],
  Accepted: [],
  Rejected: [],
  Withdrawn: [],
  Closed: [],
};

/**
 * Whether `action` may run against an application currently at `status`.
 * Terminal statuses (Accepted/Rejected/Withdrawn/Closed) never allow a
 * transition action normally — the only way through is an explicit,
 * user-confirmed `override`, which this function honors but
 * `getActionVisibility` surfaces distinctly so the UI can require
 * confirmation rather than silently allowing it.
 */
export const isActionAllowed = (status: string, action: TransitionAction, override = false): boolean => {
  if (override) return true;
  const allowed = TRANSITION_MATRIX[status];
  return allowed ? allowed.includes(action) : false;
};

export type ActionVisibility = 'visible' | 'requiresOverride' | 'hidden';

/**
 * Drives which quick-action buttons the UI shows for a given status: a plain
 * button when the transition is normally allowed, a confirm-then-override
 * button when it's only reachable by breaking out of a terminal status, or
 * nothing at all when the transition is simply out of order (e.g. marking an
 * application applied a second time) — those are never offered, with or
 * without confirmation.
 */
export const getActionVisibility = (status: string, action: TransitionAction): ActionVisibility => {
  if (isActionAllowed(status, action)) return 'visible';
  return isTerminalStatus(status) ? 'requiresOverride' : 'hidden';
};

/** True once an application has moved past the pre-application statuses, regardless of whether `dateApplied` is set. */
export const hasSubmittedApplication = (status: string): boolean => status !== 'Not Applied' && status !== 'Preparing';

export class WorkflowTransitionError extends Error {}

/** Server-side enforcement — throws with a message safe to return to the client. */
export const assertActionAllowed = (status: string, action: TransitionAction, override = false): void => {
  if (isActionAllowed(status, action, override)) return;
  if (isTerminalStatus(status)) {
    throw new WorkflowTransitionError(`This application is already ${status} — set "override" to make ${action} changes anyway`);
  }
  throw new WorkflowTransitionError(`"${action}" is not a valid transition from status "${status}"`);
};
