import { handleForecast } from "../../web/src/assistant/forecastProxy.ts";

// The stock forecast's model proxy, for the availability agent's stock_forecast tool. It calls NVIDIA
// Kumo Relational, hosted by NVIDIA, with the same key as the assistant (NVIDIA_API_KEY).
// NVIDIA_FORECAST=off turns the forecast off. See docs/deploy-netlify.md.
export default (request: Request) => handleForecast(request, { key: process.env.NVIDIA_API_KEY, forecast: process.env.NVIDIA_FORECAST });

export const config = { path: "/api/forecast" };
