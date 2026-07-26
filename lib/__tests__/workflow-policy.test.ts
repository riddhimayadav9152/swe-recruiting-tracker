import { describe, expect, it } from 'vitest';
import {
  assertActionAllowed,
  getActionVisibility,
  hasSubmittedApplication,
  isActionAllowed,
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
    expect(getActionVisibility('Recruiter Screen', 'oaCompleted')).toBe('hidden');
  });
});

describe('explicit transition overrides', () => {
  it('allows an otherwise-disallowed transition when override is true', () => {
    expect(isActionAllowed('Rejected', 'oaReceived', true)).toBe(true);
    expect(isActionAllowed('Rejected', 'interviewReceived', true)).toBe(true);
    expect(() => assertActionAllowed('Rejected', 'oaReceived', true)).not.toThrow();
  });

  it('still throws without an override', () => {
    expect(() => assertActionAllowed('Rejected', 'oaReceived', false)).toThrow('override');
  });

  it('getActionVisibility reports "visible" everywhere, override is a call-time decision not a status', () => {
    // getActionVisibility describes what the button should look like before
    // the user has confirmed anything; assertActionAllowed is what actually
    // gates the request once override has been explicitly set.
    expect(getActionVisibility('Applied', 'oaReceived')).toBe('visible');
  });
});

describe('hasSubmittedApplication', () => {
  it('is false before an application has been submitted', () => {
    expect(hasSubmittedApplication('Not Applied')).toBe(false);
    expect(hasSubmittedApplication('Preparing')).toBe(false);
  });

  it('is true for every status after submission, regardless of dateApplied', () => {
    for (const status of ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted', 'Rejected', 'Withdrawn', 'Closed']) {
      expect(hasSubmittedApplication(status)).toBe(true);
    }
  });
});
