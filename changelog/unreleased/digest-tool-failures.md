### Improved

- **System analysis:** failed tool calls are split into Geniro's own tools, other MCP servers and ordinary shell and file commands, only the first two count as trouble, and each Geniro tool's failures come grouped by error message with a count and an example, so the analysis no longer reads hundreds of threads' rows to learn why a tool failed
