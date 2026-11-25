# Deploy the demo on Netlify

The site is static: the OISS landing page at `/` and the demo store at `/demo/`. Netlify builds it from this repository on every push, using the settings in [`netlify.toml`](../netlify.toml), so there is nothing to configure in the Netlify dashboard beyond linking the repo.

## Link the repository (once)

1. In Netlify, choose **Add new project** (**Add new site** in older dashboards) → **Import an existing project** → **GitHub**, and pick `bcyong/oiss`.
2. Leave the build settings empty. Netlify reads them from `netlify.toml`:
   - Build command: `npm run build:web`
   - Publish directory: `web/dist`
   - Node version: 22
3. Set the production branch to `main` and deploy.

After that:

- Every push to `main` deploys the live site.
- Every pull request gets its own deploy preview, linked from the pull request.

## What the build does

`npm run build:web` runs two steps:

1. `npm run golden` runs the store simulator for the golden day (store `demo-001`, Tuesday November 17, 2026, seed 20261117) and writes the OISS records to `web/public/data/`.
2. `npm run build -w web` type-checks the web app and bundles it with Vite into `web/dist/`, records included.

The records are generated at build time and never committed. CI checks that they match `sim/golden/manifest.json`, so the deployed day is the same day the tests checked.

## Run it locally first

```sh
npm install
npm run dev            # generates the golden day, then serves the site at http://localhost:5173 (demo at /demo/)
npm run build:web      # the same build Netlify runs
npm run preview -w web # serves web/dist
```
