# ride-announcement-generator

A ride announcement generator for Slack with weather + route-aware hydration guidance.

## Run locally

1. Install dependencies:

	npm install

2. (Optional but recommended) Configure Strava token for reliable route distance detection:

	cp .env.example .env

	Then set `STRAVA_ACCESS_TOKEN` in `.env`.

3. Start the app:

	npm start

4. Open:

	http://localhost:3000

## Why a backend is needed for Strava distance

- Browser-only scraping is often blocked by CORS and anti-bot protections.
- The backend endpoint `/api/strava/route-distance` tries scraping and embed methods first, then uses the Strava API token fallback.
- The generated Slack post includes the route link but does not print distance.
