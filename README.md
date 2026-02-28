# Crunchyroll Release Calendar

Static calendar site that reads `data/schedule.json` and displays upcoming Crunchyroll episodes with clickable episode links.
Default UI filter is `Japanese (Original)` audio, with a dropdown to switch audio tracks.

## Automatic Data Sync

This project includes an updater script:

- `scripts/update-schedule.mjs`

It opens Crunchyroll's **premium simulcast calendar** in a Playwright browser session and extracts episode links/dates directly from:

- `https://www.crunchyroll.com/simulcastcalendar?filter=premium`
- dated pages like `https://www.crunchyroll.com/simulcastcalendar?filter=premium&date=YYYY-MM-DD`

The script scans a rolling date window around today and writes normalized results to `data/schedule.json`.

## Setup

```powershell
npm install
npx playwright install chromium
```

## Refresh Schedule Data

```powershell
npm run update:schedule
```

## Publish Free (GitHub Pages + Auto Updates)

1. Create a public GitHub repository and push this project.
2. In GitHub, go to `Settings -> Pages`.
3. Under `Build and deployment`, choose:
   - `Source: Deploy from a branch`
   - `Branch: main` (or your default branch), folder `/ (root)`
4. Save. Your site URL will be:
   - `https://<your-github-username>.github.io/<repo-name>/`
5. This repo includes a workflow at:
   - `.github/workflows/update-schedule.yml`
6. It runs every 30 minutes and updates `data/schedule.json` automatically.

If your workflow is blocked from writing commits, go to:

- `Settings -> Actions -> General -> Workflow permissions`
- Select `Read and write permissions`
- Save

## Run the Website

```powershell
npm run serve
```

Open:

- `http://localhost:8080`

## Notes

- On first run, a browser window opens; complete any Cloudflare/login checks in that window.
- The persistent browser profile is stored in `.playwright-profile/` so future runs are smoother.
