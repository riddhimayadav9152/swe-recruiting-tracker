import { describe, expect, it } from 'vitest';
import {
  assertActionAllowed,
  getActionVisibility,
  hasSubmittedApplication,
  isActionAllowed,
  isMissingApplicationDate,
  isTerminalStatus,
  TERMINAL_STATUSES,
  WorkflowTransitionError,
  type TransitionAction,
} from '../workflow-policy';

const ALL_ACTIONS: TransitionAction[] = ['apply', 'oaReceived', 'oaCompleted', 'interviewReceived', 'interviewCompleted', 'reject', 'offer'];

describe('allowed transition matrix', () => {
  it('only allows applying (or rejecting) before an application is submitted', () => {
    for (const status of ['Not Applied', 'Preparing']) {
      expect(isActionAllowed(status, 'apply')).toBe(true);
      expect(isActionAllowed(status, 'reject')).toBe(true);
      expect(isActionAllowed(status, 'oaReceived')).toBe(false);
      expect(isActionAllowed(status, 'interviewReceived')).toBe(false);
      expect(isActionAllowed(status, 'offer')).toBe(false);
    }
  });

  it('allows OA and interview invitations once applied', () => {
    expect(isActionAllowed('Applied', 'oaReceived')).toBe(true);
    expect(isActionAllowed('Applied', 'interviewReceived')).toBe(true);
    expect(isActionAllowed('Applied', 'offer')).toBe(true);
    expect(isActionAllowed('Applied', 'apply')).toBe(false);
    expect(isActionAllowed('Applied', 'oaCompleted')).toBe(false);
  });

  it('allows completing an OA only once one has been received', () => {
    expect(isActionAllowed('OA', 'oaCompleted')).toBe(true);
    expect(isActionAllowed('Applied', 'oaCompleted')).toBe(false);
  });

  it('allows completing an interview only from an interview stage', () => {
    for (const status of ['Recruiter Screen', 'Technical Interview', 'Final Round']) {
      expect(isActionAllowed(status, 'interviewCompleted')).toBe(true);
      expect(isActionAllowed(status, 'interviewReceived')).toBe(true);
    }
    expect(isActionAllowed('OA', 'interviewCompleted')).toBe(false);
  });

  it('permits OA Received after a recruiter screen (and any interview stage), to support realistic sequences', () => {
    // Real pipelines aren't strictly linear — an OA can be assigned after an
    // initial recruiter screen, or a second OA/interview round can follow.
    for (const status of ['Recruiter Screen', 'Technical Interview', 'Final Round']) {
      expect(isActionAllowed(status, 'oaReceived')).toBe(true);
    }
  });

  it('supports multiple OAs and multiple interview rounds', () => {
    // A second OA while already mid-assessment, or another interview round
    // while already in an interview stage, are both legitimate.
    expect(isActionAllowed('OA', 'oaReceived')).toBe(true);
    for (const status of ['Recruiter Screen', 'Technical Interview', 'Final Round']) {
      expect(isActionAllowed(status, 'interviewReceived')).toBe(true);
    }
  });

  it('only allows reject/re-offer from Offer status', () => {
    expect(isActionAllowed('Offer', 'offer')).toBe(true);
    expect(isActionAllowed('Offer', 'reject')).toBe(true);
    expect(isActionAllowed('Offer', 'oaReceived')).toBe(false);
    expect(isActionAllowed('Offer', 'interviewReceived')).toBe(false);
  });
});

describe('terminal statuses block transitions without override', () => {
  it('identifies exactly the four terminal statuses', () => {
    expect(TERMINAL_STATUSES).toEqual(['Accepted', 'Rejected', 'Withdrawn', 'Closed']);
    expect(isTerminalStatus('Rejected')).toBe(true);
    expect(isTerminalStatus('Withdrawn')).toBe(true);
    expect(isTerminalStatus('Closed')).toBe(true);
    expect(isTerminalStatus('Accepted')).toBe(true);
    expect(isTerminalStatus('Offer')).toBe(false);
    expect(isTerminalStatus('OA')).toBe(false);
  });

  it('disallows every transition action from a terminal status without override', () => {
    for (const status of TERMINAL_STATUSES) {
      for (const action of ALL_ACTIONS) {
        expect(isActionAllowed(status, action)).toBe(false);
      }
    }
  });

  it('does not silently let a Rejected/Withdrawn/Closed/Accepted application return to OA or interview stages', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(() => assertActionAllowed(status, 'oaReceived')).toThrow(WorkflowTransitionError);
      expect(() => assertActionAllowed(status, 'interviewReceived')).toThrow(WorkflowTransitionError);
    }
  });

  it('reports these actions as requiring an override in the UI, not simply hidden', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(getActionVisibility(status, 'oaReceived')).toBe('requiresOverride');
      expect(getActionVisibility(status, 'interviewReceived')).toBe('requiresOverride');
    }
  });

  it('hides — rather than offers with override — actions that are simply out of order on a non-terminal status', () => {
    expect(getActionVisibility('OA', 'apply')).toBe('hidden');
    expect(getActionVisibility('Not Applied', 'offer')).toBe('hidden');
  });
});

describe('explicit transition overrides are scoped to terminal statuses only', () => {
  it('allows an otherwise-disallowed transition when the current status is terminal and override is true', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isActionAllowed(status, 'oaReceived', true)).toBe(true);
      expect(isActionAllowed(status, 'interviewReceived', true)).toBe(true);
      expect(() => assertActionAllowed(status, 'oaReceived', true)).not.toThrow();
    }
  });

  it('still throws for a terminal status without an override', () => {
    expect(() => assertActionAllowed('Rejected', 'oaReceived', false)).toThrow('override');
  });

  it('rejects override:true for an invalid transition from a NON-terminal status (Not Applied -> Offer)', () => {
    // This is the key regression case: override must never turn a
    // structurally-impossible transition into a valid one just because the
    // caller asked nicely.
    expect(isActionAllowed('Not Applied', 'offer', true)).toBe(false);
    expect(() => assertActionAllowed('Not Applied', 'offer', true)).toThrow(WorkflowTransitionError);
    expect(() => assertActionAllowed('Not Applied', 'offer', true)).toThrow(/not a valid transition/);
  });

  it('rejects override:true for other non-terminal out-of-order transitions too', () => {
    expect(isActionAllowed('OA', 'apply', true)).toBe(false);
    expect(isActionAllowed('Applied', 'oaCompleted', true)).toBe(false);
    expect(isActionAllowed('Preparing', 'interviewReceived', true)).toBe(false);
  });

  it('getActionVisibility reports "visible" wherever the transition is already normally allowed', () => {
    expect(getActionVisibility('Applied', 'oaReceived')).toBe('visible');
  });
});

describe('hasSubmittedApplication / isMissingApplicationDate', () => {
  it('is false before an application has been submitted', () => {
    expect(hasSubmittedApplication({ status: 'Not Applied', dateApplied: null })).toBe(false);
    expect(hasSubmittedApplication({ status: 'Preparing', dateApplied: null })).toBe(false);
  });

  it('is true for Applied and every later status, even without a dateApplied, since they are only reachable via submission', () => {
    for (const status of ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted']) {
      expect(hasSubmittedApplication({ status, dateApplied: null })).toBe(true);
    }
  });

  it('is true whenever dateApplied is set, regardless of status', () => {
    expect(hasSubmittedApplication({ status: 'Not Applied', dateApplied: '2026-07-01' })).toBe(true);
    expect(hasSubmittedApplication({ status: 'Rejected', dateApplied: '2026-07-01' })).toBe(true);
  });

  it('is true for a Rejected/Withdrawn/Closed record with an "Application submitted" activity entry', () => {
    for (const status of ['Rejected', 'Withdrawn', 'Closed']) {
      expect(hasSubmittedApplication({ status, dateApplied: null, activities: [{ eventType: 'Application submitted' }] })).toBe(true);
    }
  });

  it('does NOT assume submission for a Rejected/Withdrawn/Closed record with no dateApplied and no submission activity — a role can close before you ever apply', () => {
    for (const status of ['Rejected', 'Withdrawn', 'Closed']) {
      expect(hasSubmittedApplication({ status, dateApplied: null, activities: [{ eventType: 'Opportunity created' }] })).toBe(false);
    }
  });

  it('shows the missing-date warning for Applied, OA, interview stages, Offer and Accepted when dateApplied is absent', () => {
    for (const status of ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted']) {
      expect(isMissingApplicationDate({ status, dateApplied: null })).toBe(true);
    }
  });

  it('does not warn once dateApplied is present', () => {
    expect(isMissingApplicationDate({ status: 'Applied', dateApplied: '2026-07-01' })).toBe(false);
  });

  it('does not warn for a pre-application rejection or closure (no dateApplied, no submission evidence)', () => {
    expect(isMissingApplicationDate({ status: 'Rejected', dateApplied: null, activities: [{ eventType: 'Opportunity created' }, { eventType: 'Rejected' }] })).toBe(false);
    expect(isMissingApplicationDate({ status: 'Closed', dateApplied: null, activities: [] })).toBe(false);
  });

  it('still warns for a Rejected record that DID have a submission (dateApplied cleared some other way, or submitted-then-rejected with a backfilled record)', () => {
    expect(isMissingApplicationDate({ status: 'Rejected', dateApplied: null, activities: [{ eventType: 'Application submitted' }, { eventType: 'Rejected' }] })).toBe(true);
  });
});
