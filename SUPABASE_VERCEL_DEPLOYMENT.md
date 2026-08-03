# Supabase + Vercel Deployment

This is the no-credit-card deployment path. Local development and tests keep using SQLite through `prisma/schema.prisma`; cloud deployment uses Supabase Postgres through `prisma/schema.postgres.prisma`.

## 1. Clean sensitive data first

Do not put real passwords in the tracker. The app only has a password-manager reference field; it is not encrypted credential storage.

Before exporting cloud data, remove or rotate any value that is an actual password.

## 2. Create a Supabase project

Create a free Supabase project and save the database password.

In Supabase Dashboard, find the Prisma connection strings. You need both:

- `DATABASE_URL`: pooled/transaction-pooler connection string for the deployed app.
- `DIRECT_URL`: direct connection string for migrations/schema pushes.

## 3. Push the Postgres schema

Run these locally with the values copied from Supabase:

```bash
export DATABASE_URL='postgresql://...'
export DIRECT_URL='postgresql://...'
npm run prisma:push:postgres
```

Then open Supabase SQL Editor and run:

```sql
-- paste prisma/supabase-lockdown.sql
```

## 4. Export current SQLite data

```bash
npm run db:backup
npm run db:export-postgres-sql
```

This writes a file like:

```text
data/postgres-import-YYYYMMDD-HHMMSS.sql
```

The file is ignored by git because it contains your real tracker data.

## 5. Import data into Supabase

Open the generated `data/postgres-import-*.sql` file locally, copy the SQL, paste it into Supabase SQL Editor, and run it.

Verify counts in Supabase SQL Editor:

```sql
select count(*) from "Application";
```

The expected count should match your local tracker count.

## 6. Deploy on Vercel

Create a Vercel project from the GitHub repo.

Set environment variables:

- `DATABASE_URL`: Supabase pooled Prisma connection string.
- `DIRECT_URL`: Supabase direct connection string.
- `APP_USERNAME`: `riddhi` or another username.
- `APP_PASSWORD`: a strong password.

The repo includes `vercel.json`, so Vercel will run:

```bash
npm run vercel:build
```

## 7. Verify before using

Open the Vercel URL and sign in with the browser password prompt.

Check:

- The application count matches the local count.
- A known application has its notes/links/job description.
- Editing and saving an application works.

After this passes, bookmark the Vercel URL.

## Supabase backup behavior

The local SQLite app creates file backups before import commits. The Vercel/Supabase deployment uses a managed Postgres database, so import commits do not try to write SQLite backup files to Vercel's read-only deployment filesystem.

Before large cloud imports, use the app's workbook export or a Supabase database backup/export as your rollback point.
