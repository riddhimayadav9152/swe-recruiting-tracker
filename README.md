# Local SWE Recruiting Tracker

A polished local web app for tracking a 2027 software engineering internship recruiting cycle without Excel maintenance.

## Features

- Local Next.js + TypeScript app with SQLite persistence
- Recruiter workflow actions for applications, OA, interviews, offers, and rejections
- Dashboard, pipeline, deadlines, job-description storage, contacts, resumes, activity history, import/export, and settings
- Seeded profile and sample data

## Setup

```bash
npm install
npx prisma db push
node prisma/seed.mjs
npm run dev
```

Open http://localhost:3000.

## Backup and restore

- Backup database: use the Import / Export page or download from the backup route.
- Restore: upload a SQLite backup from the Import / Export page.

## Notes

- The database lives in data/dev.db and is not committed to Git.
- The initial build intentionally keeps the scope local and does not include cloud hosting or authentication.
