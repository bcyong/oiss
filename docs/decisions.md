# Demo decisions

Decisions for the public OISS site and demo, made on November 25, 2026. Each one says what was chosen and what it means for the build.

| Question | Decision | What it means |
| --- | --- | --- |
| Where the store simulation runs | In the browser, plus whatever server pieces the demo needs | The simulator is plain TypeScript with no Node-only code, so the web app can run it directly. The build also writes one fixed "golden day" of records as static files, so the demo loads instantly and every visitor sees the same day. Server pieces arrive only where needed, such as the agents in M4. |
| Agent model | An NVIDIA-hosted model | The Store Operations Assistant (M4) calls a model hosted on build.nvidia.com. Setting up the account and key waits for a go-ahead. |
| Hosting | Netlify | The repository's `netlify.toml` holds the build settings, so linking the repo on Netlify deploys the demo from `main` and gives each pull request a preview. See [deploy-netlify.md](deploy-netlify.md). |
| Store type | Grocery | One synthetic supermarket, store `demo-001`, with produce, bakery, deli, dairy, meat and seafood, frozen, six center-store aisles, endcaps, eight staffed checkout lanes and six self-checkouts. |
| Evidence images | Placeholder images first, real frames later | M2 and M3 show placeholder images for Evidence records. Real camera frames come from the hands-on Metropolis exercises once they produce data. |
| Web stack | React with SVG | The floor plan is drawn as SVG by React components, built with Vite. |
| Site layout | Landing page like a blueprint card, demo at `/demo` | `/` presents OISS in the order of a blueprint card (overview, architecture diagram, key features, requirements, software used, ethical considerations, license), and the demo store lives at `/demo/`. |
