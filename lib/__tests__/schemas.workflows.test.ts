import { describe, expect, it } from 'vitest';
import { applicationCreateSchema, workflowPayloadSchema } from '../schemas/workflows';

describe('applicationCreateSchema restricts the standard creation endpoint', () => {
  const base = { company: 'Acme', role: 'Software Engineer', applicationUrl: 'https://acme.com/apply', priority: 'P1' as const };

  it('accepts Not Applied and Preparing', () => {
    expect(applicationCreateSchema.safeParse({ ...base, status: 'Not Applied' }).success).toBe(true);
    expect(applicationCreateSchema.safeParse({ ...base, status: 'Preparing' }).success).toBe(true);
    expect(applicationCreateSchema.safeParse(base).success).toBe(true); // status is optional
  });

  it('rejects every advanced status — those are only reachable through a workflow action', () => {
    for (const status of ['Applied', 'OA', 'Recruiter Screen', 'Technical Interview', 'Final Round', 'Offer', 'Accepted', 'Rejected', 'Withdrawn', 'Closed']) {
      const result = applicationCreateSchema.safeParse({ ...base, status });
      expect(result.success).toBe(false);
    }
  });

  it('rejects an impossible calendar date for applicationDeadline/dateFound', () => {
    expect(applicationCreateSchema.safeParse({ ...base, applicationDeadline: '2026-02-31' }).success).toBe(false);
    expect(applicationCreateSchema.safeParse({ ...base, dateFound: '2026-04-31' }).success).toBe(false);
    expect(applicationCreateSchema.safeParse({ ...base, applicationDeadline: '2026-08-15' }).success).toBe(true);
  });
});

describe('workflowPayloadSchema validates interview timezone and dates strictly', () => {
  const validInterview = {
    action: 'interviewReceived' as const,
    stage: 'Recruiter Screen' as const,
    scheduledStart: '2026-08-15T14:00',
    timezone: 'America/Los_Angeles',
  };

  it('accepts a valid IANA timezone', () => {
    expect(workflowPayloadSchema.safeParse(validInterview).success).toBe(true);
  });

  it('requires timezone — it can no longer be omitted', () => {
    const withoutTimezone: Record<string, unknown> = { ...validInterview };
    delete withoutTimezone.timezone;
    expect(workflowPayloadSchema.safeParse(withoutTimezone).success).toBe(false);
  });

  it('rejects a non-IANA timezone string', () => {
    expect(workflowPayloadSchema.safeParse({ ...validInterview, timezone: 'Pacific Time' }).success).toBe(false);
    expect(workflowPayloadSchema.safeParse({ ...validInterview, timezone: '' }).success).toBe(false);
  });

  it('rejects an impossible scheduledStart date/time', () => {
    expect(workflowPayloadSchema.safeParse({ ...validInterview, scheduledStart: '2026-02-31T10:00' }).success).toBe(false);
    expect(workflowPayloadSchema.safeParse({ ...validInterview, scheduledStart: '2026-08-15T25:00' }).success).toBe(false);
  });

  it('rejects an offer with an impossible decisionDeadline', () => {
    const offer = { action: 'offer' as const, decisionDeadline: '2026-02-31' };
    expect(workflowPayloadSchema.safeParse(offer).success).toBe(false);
  });

  it('still requires dueAt, stage+scheduledStart, decisionDeadline, nonempty note content, and nonempty contact name (resumeVersionId is no longer required for apply)', () => {
    // Resume tracking is no longer part of Mark Applied — an empty payload
    // (no resumeVersionId at all) is now perfectly valid.
    expect(workflowPayloadSchema.safeParse({ action: 'apply' }).success).toBe(true);
    expect(workflowPayloadSchema.safeParse({ action: 'oaReceived' }).success).toBe(false);
    expect(workflowPayloadSchema.safeParse({ action: 'interviewReceived', stage: 'Recruiter Screen' }).success).toBe(false);
    expect(workflowPayloadSchema.safeParse({ action: 'offer' }).success).toBe(false);
    expect(workflowPayloadSchema.safeParse({ action: 'note', content: '' }).success).toBe(false);
    expect(workflowPayloadSchema.safeParse({ action: 'contact', name: '' }).success).toBe(false);
  });
});
