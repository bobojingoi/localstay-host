# StayPredeal — Deploy it (first-timer walkthrough)

This is your backend. It serves the importer, the admin, and the public sites, and stores everything in a Postgres database. Follow the steps in order. No prior deployment experience assumed — where you have to click something, it says so.

**What you'll have at the end:** a live web address where you open the importer, drop in a property JSON, and immediately get a working public site and admin — with the data saved in a real database, not just your browser.

---

## What's in this folder

```
backend/
  server.js          the web server (API + serves the pages + iCal export)
  db.js              connects to Postgres, creates the table on first run
  schema.sql         the database table
  transform.js       master JSON → site + admin (same logic as the app)
  package.json       the dependency list
  render.yaml        tells Render what to create (web service + database)
  .env.example       template for your local settings
  public/            importer.html, admin-console.html, the site template
```

You don't need to edit any of these to deploy. Edit them later when you want to change behaviour.

---

## Step 0 — Install two free tools (once)

1. **Node.js** (this runs the server). Download the "LTS" version from https://nodejs.org and install it. To check it worked, open a terminal (Mac: Terminal app / Windows: PowerShell) and type:
   ```
   node --version
   ```
   You should see something like `v20.x` or higher.

2. **Git** (this uploads your code). Get it from https://git-scm.com/downloads. Check:
   ```
   git --version
   ```

Also create a free account at **https://github.com** and a free account at **https://render.com** (you can sign in to Render *with* your GitHub account — easiest).

---

## Step 1 — Get the project onto your computer

Download the `staypredeal-backend.zip` I gave you and unzip it. You'll get the `backend/` folder above. Open a terminal **inside that folder**:

- Mac: drag the folder onto the Terminal icon, or `cd ` then drag the folder in and press Enter.
- Windows: open the folder, click the address bar, type `powershell`, press Enter.

---

## Step 2 — (Optional but recommended) Try it on your own computer first

This lets you see it working before you put it online. You need a database; the easiest free one is **Neon** (no install).

1. Go to https://neon.tech, sign up, create a project. Copy the **connection string** it shows (starts with `postgres://`).
2. In the project folder, make a copy of `.env.example` and name it `.env`. Open it and paste your connection string after `DATABASE_URL=`. Leave `BASE_DOMAIN=` empty.
3. In the terminal:
   ```
   npm install
   npm start
   ```
   You should see `Database ready.` and `StayPredeal running on port 3000`.
4. Open your browser at **http://localhost:3000**. The importer appears. Drop in a property JSON (or paste it) → click **Importă și generează** → it takes you to the admin, and the **Site** button shows the live page.

Press `Ctrl+C` in the terminal to stop it. If this worked, putting it online is the same thing on Render's computers.

> Don't want to bother with local testing? Skip to Step 3 — Render gives you a database automatically.

---

## Step 3 — Put your code on GitHub

Render deploys from a GitHub repository. In the project folder terminal:

```
git init
git add .
git commit -m "StayPredeal backend"
```

Then on https://github.com click **New repository**, name it `staypredeal-backend`, keep it **Private**, and click **Create**. GitHub then shows two lines under "…or push an existing repository" — copy and run them. They look like:

```
git remote add origin https://github.com/YOUR-NAME/staypredeal-backend.git
git branch -M main
git push -u origin main
```

Refresh the GitHub page — your files are now there.

> Note: the `.env` file is ignored by Git on purpose (it holds your password). Your secret connection string does **not** get uploaded. Render gets its own.

---

## Step 4 — Deploy on Render (the actual "going live")

1. Go to the Render dashboard → **New +** → **Blueprint**.
2. Connect your GitHub and pick the `staypredeal-backend` repo. Render reads `render.yaml` and shows it will create **two things**: a web service `staypredeal` and a Postgres database `staypredeal-db`.
3. Click **Apply**. Render now:
   - creates the database,
   - wires its connection string into the web service automatically (that's the `DATABASE_URL` line in `render.yaml` — you don't type it),
   - installs dependencies and starts the server,
   - and your `db.js` creates the table on first boot (no manual database setup).
4. Wait for the web service to show **Live** (first deploy ~2–4 minutes). Click the URL at the top — it looks like `https://staypredeal.onrender.com`.

That URL is your live importer. Open it, import a property, click **Site** and **Admin** — both load from the database now. Edits you save in the admin update the public site.

> Cost: the `starter` plan in `render.yaml` is about $7/month and never sleeps. To test for free first, change `plan: starter` to `plan: free` (note: free web services sleep after 15 min idle, and the free database is deleted after 30 days). Edit, commit, push — Render redeploys automatically.

---

## Step 5 — Connect your domain and the `*.staypredeal.ro` subdomains (when ready)

This is what turns `staypredeal.onrender.com/s/vila-maria` into `vila-maria.staypredeal.ro`.

1. Put your domain on **Cloudflare** (free): add the site, and change your domain's nameservers at your registrar to the two Cloudflare gives you.
2. In Cloudflare DNS, add a record: type `CNAME`, name `*` (just the asterisk), target your Render URL `staypredeal.onrender.com`, proxy **off** (grey cloud) to start. Add another `CNAME` for the root if you want `staypredeal.ro` itself.
3. In Render → your web service → **Settings** → **Custom Domains**, add `*.staypredeal.ro` (and `staypredeal.ro`). Render issues the SSL certificate automatically.
4. In Render → **Environment**, set `BASE_DOMAIN` to `staypredeal.ro` and save (it redeploys). Now any imported property at slug `vila-maria` is live at `https://vila-maria.staypredeal.ro` — the server reads the subdomain, finds the property, and serves its site.

If wildcard activation gives an SSL error through Cloudflare, it's the known "orange-to-orange" rule: the root domain must also point to Render. Easiest fix early on is leaving the wildcard record **grey-clouded** (proxy off) in Cloudflare.

---

## If something goes wrong

- **Web service shows "Failed"** → open the **Logs** tab in Render. The most common first-deploy cause is the database not being ready yet; click **Manual Deploy → Deploy latest commit** to retry.
- **Page loads but importing errors** → check Logs for a message; usually the JSON wasn't the expected `general.* + rooms` shape.
- **"relation properties does not exist"** → the schema didn't run; redeploy. `db.js` runs `schema.sql` every boot, so a redeploy fixes it.
- **Changed code but nothing changed online** → you forgot to `git add . && git commit -m "..." && git push`. Render only deploys what's pushed to GitHub.

---

## What this version does and doesn't do (so you're not surprised)

This is a deliberately simple first version. It is real and production-deployable, but:

- **Data is stored as JSON in one table.** That's fine for hundreds of properties. When you want to run availability reports in SQL, split into the normalized tables in `BACKEND-GUIDE.md` — the API stays the same.
- **The public site is rendered in the browser** from data the server injects. Good enough to launch. For best Google ranking, render the HTML on the server later (also in the guide).
- **There's no login yet.** Anyone with the URL can open the admin. Before a real launch, add host accounts — the simplest path is Supabase Auth or Clerk in front of the `/admin` and `/api/host/...` routes.
- **iCal sync from Booking/Airbnb URLs** needs the scheduled job (a few lines using `node-cron` that fetch each feed and update blocks). The export side (`/ical/:slug/:unit.ics`) already works. Add the import cron when you connect your first channel.

Each of these is an add-on, not a rewrite. Get it live first; grow it from there.
