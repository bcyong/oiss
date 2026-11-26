import { handleAssistant } from "../../web/src/assistant/proxy.ts";

// The Store Operations Assistant's model proxy. The NVIDIA API key lives only in the site's environment
// variables (NVIDIA_API_KEY); NVIDIA_MODEL can name another NVIDIA-hosted model. See docs/deploy-netlify.md.
export default (request: Request) => handleAssistant(request, { key: process.env.NVIDIA_API_KEY, model: process.env.NVIDIA_MODEL });

export const config = { path: "/api/assistant" };
