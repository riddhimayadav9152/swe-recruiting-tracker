# Deployment

This app stores its data in SQLite. Use a host with persistent disk storage and keep `DATABASE_URL` pointed at that disk.

## Local backup

Create a backup before any deploy or restore:

```bash
npm run db:backup
```

Restore a backup locally:

```bash
npm run db:restore -- data/backups/dev-YYYYMMDD-HHMMSS.db
```

## Render setup

The included `render.yaml` creates a Node web service with a persistent disk mounted at `/var/data`.

Set these environment variables in Render:

- `DATABASE_URL=file:/var/data/dev.db`
- `APP_USERNAME=riddhi`
- `APP_PASSWORD=<choose a strong password>`

The app refuses production traffic when `APP_PASSWORD` is missing.

## Moving current local data

Your local database is `data/dev.db`. Before deploying real data:

```bash
npm run db:backup
```

Upload the chosen backup to the persistent disk as `/var/data/dev.db`, then restart the service. Do not store the real database in git.
