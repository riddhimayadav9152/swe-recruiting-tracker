export type NoteRecord = {
  id: string;
  category: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type LinkRecord = {
  id: string;
  label: string;
  url: string;
  category: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ActivityRecord = {
  id: string;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  previousStage: string | null;
  newStage: string | null;
  summary: string;
  createdAt: string;
};

export type ApplicationRecord = {
  id: string;
  applicationCode: string;
  company: string;
  role: string;
  jobId: string | null;
  status: string;
  currentStage: string | null;
  priority: string;
  postingStatus: string | null;
  applicationUrl: string | null;
  candidatePortalUrl: string | null;
  location: string | null;
  workModel: string | null;
  postingDate: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  nextActionDueKind: 'date' | 'timestamp';
  applicationDeadline: string | null;
  dateFound: string | null;
  dateApplied: string | null;
  emailUsed: string | null;
  portalUsername: string | null;
  passwordManagerReference: string | null;
  confirmationNumber: string | null;
  compensationSummary: string | null;
  eligibility: string | null;
  sponsorship: string | null;
  whyFit: string | null;
  lastVerifiedAt: string | null;
  outcome: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  jobDescription: { fullText: string | null; sourceUrl: string | null; keywords: string | null } | null;
  resumeVersion: { id: string; name: string } | null;
  interviews: Array<{ id: string; stage: string; scheduledStart: string | null; timezone: string | null; completedAt: string | null; notes: string | null }>;
  assessments: Array<{ id: string; type: string; dueAt: string | null; timezone: string | null; platform: string | null; durationMinutes: number | null; questionCount: number | null; topics: string | null; completedAt: string | null; result: string | null }>;
  contacts: Array<{ name: string; email: string | null; notes: string | null }>;
  notesRelation: NoteRecord[];
  links: LinkRecord[];
  activities: ActivityRecord[];
  offers: { offerDate: string | null; decisionDeadline: string | null; compensationSummary: string | null; notes: string | null } | null;
};

export const POSTING_STATUSES = ['Open', 'Opening Soon', 'Closed', 'Unknown'] as const;
export const NOTE_CATEGORIES = ['General', 'Application', 'Company Research', 'Networking', 'OA', 'Interview', 'Offer'] as const;
export const LINK_CATEGORIES = ['Company', 'Role Research', 'Application', 'Interview Preparation', 'Recruiter', 'Other'] as const;
export const TERMINAL_STATUSES = ['Accepted', 'Rejected', 'Withdrawn', 'Closed'] as const;
