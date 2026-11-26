# Deploy the demo on Netlify

The site is static, the OISS landing page at `/` and the demo store at `/demo/`, plus one Netlify Function for the demo's Store Operations Assistant. Netlify builds it from this repository on every push, using the settings in [`netlify.toml`](../netlify.toml), so the only things to set in the Netlify dashboard are the linked repo and the assistant's API key.

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

## Switch on the Store Operations Assistant

The demo's **Ask the store** tab calls an NVIDIA-hosted model through the function in [`netlify/functions/assistant.mts`](../netlify/functions/assistant.mts), served at `/api/assistant`. The key stays on the server: the page never sees it.

1. Get an API key from [build.nvidia.com](https://build.nvidia.com).
2. In Netlify, open the project's **Project configuration** → **Environment variables** and add `NVIDIA_API_KEY` with the key, scoped to Functions.
3. Optionally add `NVIDIA_MODEL` to use another NVIDIA-hosted model that supports tool calling. The default is `nvidia/nemotron-3-ultra-550b-a55b`. If NVIDIA has retired the model (it answers 404 or 410), the function tries `nvidia/nemotron-3.5-lightning-30b-a3b` once before giving up.
4. Redeploy. Until the key is set, the tab says the assistant isn't switched on yet.

The function builds every model request itself from the agent definitions in `web/src/assistant/agents.ts`, so the key can only answer the assistant's questions. It refuses other sites' pages, caps each request's size and limits each visitor to 60 model calls per 10 minutes. That limit is kept in memory by each function instance, so it is best effort; a durable per-visitor limit and a daily spending cap come with the server work in M5. Each model call gets at most 25 seconds, well inside Netlify's 60-second limit for a function.

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

The local dev server has no functions, so **Ask the store** says the assistant runs on the deployed site. To try it locally, run the site with the Netlify CLI (`netlify dev`) with `NVIDIA_API_KEY` set in your shell.
