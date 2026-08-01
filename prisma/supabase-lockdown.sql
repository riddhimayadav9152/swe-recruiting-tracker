-- Run in Supabase SQL Editor after `npm run prisma:push:postgres`.
-- The app uses Prisma from the server; it does not need Supabase anon/authenticated
-- Data API access to these tables.

alter table "Application" enable row level security;
alter table "ApplicationLink" enable row level security;
alter table "JobDescription" enable row level security;
alter table "ResumeVersion" enable row level security;
alter table "Assessment" enable row level security;
alter table "Offer" enable row level security;
alter table "Interview" enable row level security;
alter table "Contact" enable row level security;
alter table "Note" enable row level security;
alter table "Activity" enable row level security;
alter table "Document" enable row level security;
alter table "UserProfile" enable row level security;

revoke all on table
  "Application",
  "ApplicationLink",
  "JobDescription",
  "ResumeVersion",
  "Assessment",
  "Offer",
  "Interview",
  "Contact",
  "Note",
  "Activity",
  "Document",
  "UserProfile"
from anon, authenticated;
