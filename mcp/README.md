# MCP server and agents

An MCP server over the OISS store with tools such as out-of-stocks since a time, zone status, open incidents and create task, and the Store Operations Assistant that routes questions to its agents.

The first version of the assistant is in the demo: its router, five agents and their read-only tools are in [`web/src/assistant`](../web/src/assistant), and the model proxy is the Netlify Function in [`netlify/functions/assistant.mts`](../netlify/functions/assistant.mts). The tools there read the day in the browser. The MCP server serves the same tools over the OISS store once the server work lands; it and the create-task tool are deferred until after the website. See the [work plan](../README.md#whats-here).
