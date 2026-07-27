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

// Real recruiting pipelines aren't strictly linear: an OA can arrive before
// OR after a recruiter screen, there can be more than one OA (a second-round
// assessment) or more than one interview at the same stage, and an offer can
// land at almost any point once you've applied. `oaReceived` and
// `interviewReceived` are deliberately allowed from every post-application
// status (including OA and the interview stages themselves) to support
// that, not just from "Applied".
const TRANSITION_MATRIX: Record<string, TransitionAction[] | undefined> = {
  'Not Applied': ['apply', 'reject'],
  Preparing: ['apply', 'reject'],
  Applied: ['oaReceived', 'interviewReceived', 'offer', 'reject'],
  OA: ['oaReceived', 'oaCompleted', 'interviewReceived', 'offer', 'reject'],
  'Recruiter Screen': ['oaReceived', 'interviewReceived', 'interviewCompleted', 'offer', 'reject'],
  'Technical Interview': ['oaReceived', 'interviewReceived', 'interviewCompleted', 'offer', 'reject'],
  'Final Round': ['oaReceived', 'interviewReceived', 'interviewCompleted', 'offer', 'reject'],
  Offer: ['offer', 'reject'],
  Accepted: [],
  Rejected: [],
  Withdrawn: [],
  Closed: [],
};

// Intentionally prohibited, and NOT reachable via override (override only
// ever lifts the terminal-status block below — it never makes an
// out-of-order transition valid):
//   - "apply" once already submitted (Applied or later). There's no
//     re-apply concept; if a record's status is wrong, fix the record
//     directly rather than resubmitting through the workflow.
//   - "oaCompleted"/"interviewCompleted" before any OA/interview has been
//     received at all — these require a specific existing assessmentId /
//     interviewId anyway (enforced in lib/workflows/applications.ts), so
//     there's nothing to complete from "Not Applied", "Preparing", etc.
//   - Anything at all from a terminal status (Accepted/Rejected/Withdrawn/
//     Closed) without an explicit, confirmed override — these are final
//     outcomes by design.
//
// `override: true` is scoped narrowly: it only ever bypasses the terminal
// state safeguard above. It must never make an otherwise-invalid,
// non-terminal transition (e.g. "Not Applied" -> "offer") valid — that
// would just be a different bug wearing the same trenchcoat.

/**
 * Whether `action` may run against an application currently at `status`.
 * `override` only has an effect when `status` is terminal
 * (Accepted/Rejected/Withdrawn/Closed) — it can never make an
 * out-of-order, non-terminal transition valid.
 */
export const isActionAllowed = (status: string, action: TransitionAction, override = false): boolean => {
  const allowed = TRANSITION_MATRIX[status];
  if (allowed?.includes(action)) return true;
  return override === true && isTerminalStatus(status);
};

export type ActionVisibility = 'visible' | 'requiresOverride' | 'hidden';

/**
 * Drives which quick-action buttons the UI shows for a given status: a plain
 * button when the transition is normally allowed, a confirm-then-override
 * button when it's only reachable by breaking out of a terminal status, or
 * nothing at all when the transition is simply out of order (e.g. marking an
 * application applied a second time) — those are never offered, with or
 * without confirmation, since override can't make them valid either.
 */
export const getActionVisibility = (status: string, action: TransitionAction): ActionVisibility => {
  if (isActionAllowed(status, action)) return 'visible';
  return isTerminalStatus(status) ? 'requiresOverride' : 'hidden';
};

export class WorkflowTransitionError extends Error {}

/** Server-side enforcement — throws with a message safe to return to the client. */
export const assertActionAllowed = (status: string, action: TransitionAction, override = false): void => {
  if (isActionAllowed(status, action, override)) return;
  if (isTerminalStatus(status)) {
    throw new WorkflowTransitionError(`This application is already ${status} — set "override" to make ${action} changes anyway`);
  }
  throw new WorkflowTransitionError(`"${action}" is not a valid transition from status "${status}"`);
};

// --- Submitted-application detection ---------------------------------------
//
// Rejected/Withdrawn/Closed do NOT necessarily mean an application was ever
// submitted — a role can close, or a recruiter can pass on a candidate,
// before an application was formally filed. So status alone can't tell us
// whether a submission happened; only these can:
//   - `dateApplied` is set (the direct, authoritative signal).
//   - the status is one that structurally requires having applied first —
//     per the transition matrix above, Applied and everything reachable
//     only from Applied (OA/interview stages/Offer/Accepted) can't be
//     reached any other way (see also: this exact fact is what makes it
//     safe to infer submission from them even without a `dateApplied`, e.g.
//     for a backfilled/imported record).
//   - the activity log has an "Application submitted" entry (belt-and-
//     suspenders for a record whose `dateApplied` was cleared some other
//     way).
const STATUSES_THAT_REQUIRE_SUBMISSION: readonly string[] = ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted'];

export type SubmissionEvidence = {
  status: string;
  dateApplied?: string | Date | null;
  activities?: Array<{ eventType: string }>;
};

export const hasSubmittedApplication = (app: SubmissionEvidence): boolean => {
  if (app.dateApplied) return true;
  if (STATUSES_THAT_REQUIRE_SUBMISSION.includes(app.status)) return true;
  return app.activities?.some((activity) => activity.eventType === 'Application submitted') ?? false;
};

/**
 * Whether the UI should warn that an application looks like it was
 * submitted but has no application date on record (e.g. a backfilled or
 * future-imported row). Does NOT fire for a pre-application rejection or
 * closure — those are valid states that never involved a submission.
 */
export const isMissingApplicationDate = (app: SubmissionEvidence): boolean =>
  hasSubmittedApplication(app) && !app.dateApplied;
