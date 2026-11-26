# Deploy the demo on Netlify

The site is static, the OISS landing page at `/`, the RFC at `/rfc/`, the demo store at `/demo/`, the spec browser at `/spec/` and the repository overview at `/github/`, plus one Netlify Function for the demo's Store Operations Assistant. Netlify builds it from this repository on every push, using the settings in [`netlify.toml`](../netlify.toml), so the only things to set in the Netlify dashboard are the linked repo and the assistant's API key.

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
3. Optionally pick other NVIDIA-hosted models. Each falls back once if NVIDIA has retired it (it answers 404 or 410).
   - `NVIDIA_MODEL` writes the answers and calls the tools. The default is `nvidia/nemotron-3-ultra-550b-a55b`, with `nvidia/nemotron-3.5-lightning-30b-a3b` as the fallback.
   - `NVIDIA_ROUTER_MODEL` picks the agent for each question. The default is `nvidia/nemotron-3.5-lightning-30b-a3b`, with the answer model as the fallback.
   - `NVIDIA_SAFETY_MODEL` screens each question and each answer. The default is `nvidia/nemotron-3.5-content-safety`, with `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` as the fallback. `off` turns the check off. If the safety model can't be reached, the assistant carries on and marks the answer as not checked.
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

## Check the assistant's answers

The **Assistant answer check** workflow (`.github/workflows/assistant-eval.yml`) asks the five sample questions at 9 AM, 1 PM and 6 PM on the golden day, about 35 model calls plus a safety check on each question and answer, and checks every answer against the records its tools returned. An answer fails when it cites a record the tools didn't return, states a number, time or price that isn't in the tool results, gives a cause the records don't, names a team no tool returned, or says it raised a task it can only propose. A sample question the safety check turns down fails too. The summary shows each safety verdict and the model that gave it, so a safety model that never answers shows up as "unchecked". The results land in the run's summary.

It runs on pull requests that change the assistant, from the Actions tab, and every Monday. It needs the same key as the site, as a repository secret: **Settings → Secrets and variables → Actions → New repository secret**, named `NVIDIA_API_KEY`. Without it the workflow says so and passes. Repository variables `NVIDIA_MODEL`, `NVIDIA_ROUTER_MODEL` and `NVIDIA_SAFETY_MODEL` pick other models, as on Netlify.

To run it yourself: `NVIDIA_API_KEY=... npm run eval:assistant -w web`, or point it at a deployed site's assistant with `EVAL_URL=https://<site>/api/assistant`.
