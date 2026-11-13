# MetaInfer Research Lab — MCP control surface

The Lab Host exposes a **Streamable HTTP MCP** endpoint on the DSH Web origin:

```text
http://127.0.0.1:3080/mcp/metainfer-research-lab
```

An external agent should configure it as a `streamable-http` MCP server. No second
port or URL is required.

## Permission model

Only one tool writes:

```text
metainfer_create_project
```

It accepts a git repository path, a root experiment prompt, optional `config`
(including model roles and other project config), and optional initial role
prompts:

```json
{
  "workerPrefix": "...",
  "advisor": "...",
  "scheduler": "...",
  "merge": "...",
  "gc": "..."
}
```

The project is created in manual mode with one planned root node. The MCP call
does not start any experiment.

Every other tool is read-only; there are deliberately no update, start, stop,
delete, approve, retry, merge, or push tools.

## Read tools

- `metainfer_list_projects`
- `metainfer_get_project`
- `metainfer_list_nodes`
- `metainfer_get_node`
- `metainfer_get_node_transcript`
- `metainfer_get_session_transcript`
- `metainfer_list_runs`
- `metainfer_get_run`
- `metainfer_get_events`
- `metainfer_get_cluster`
- `metainfer_get_models`
- `metainfer_get_project_prompts`

`metainfer_get_session_transcript` accepts project controller, Copilot, node
worker/anchor, and advisor/scheduler/GC run sessions, provided the session belongs
to the requested project.

## Security

By default the endpoint accepts only loopback clients (`127.0.0.1`, `::1`,
`::ffff:127.0.0.1`) without a token. To connect from another host, set
`METAINFER_MCP_TOKEN` in the DSH host environment and send:

```text
Authorization: Bearer <token>
```

The endpoint is read-only except for `metainfer_create_project`; it never
requires or accepts command-line operations.
