# apps/web

> **Frontend scaffold incoming.**
>
> This directory will hold the React + Vite + Tailwind + shadcn/ui dashboard
> (see Phase 2 todos 9–13 in `plan-dashboard.md`).
>
> For now, the Docker image here serves a single placeholder HTML page on
> port 8080 so `docker compose up` is end-to-end runnable.

## Why a placeholder?

`docker-compose.yml` declares a `web` service with `depends_on: [api]` so that
the full deployment topology is exercised from day one. When the React app
lands, only this directory's `Dockerfile` and `src/` change — the compose
file stays the same.
