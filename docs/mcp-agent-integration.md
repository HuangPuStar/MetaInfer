# MetaInfer Research Lab MCP Integration Guide

This guide is written for an external coding agent that needs to inspect or
initialize MetaInfer Research Lab projects over MCP.

## 1. Endpoint

The Lab Host exposes a **Streamable HTTP MCP** endpoint on the DSH Web origin:

```text
http://127.0.0.1:3080/mcp/metainfer-research-lab
```

There is no separate MCP port and no command-line step required.

The implementation lives in `dsh-metainfer-research-lab/host/mcp.js`; the
permission model is intentionally small:

- **one write tool**: `metainfer_create_project`
- **all other tools are read-only**

## 2. Client configuration

### DSH / Cordis MCP client

Add the already-installed `@deepseek-ai/dsh-mcp-client` row through a bundle
patch (do not hand-edit the profile):

```yaml
- insert:
    - id: metainfer-lab-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: metainfer-research-lab
        transport: streamable-http
        url: http://127.0.0.1:3080/mcp/metainfer-research-lab
        failOnStartupError: true
```

The tools appear as `mcp__metainfer-research-lab__<tool-name>` (the exact prefix
is determined by the MCP client, not by this server).

### Other MCP clients

Use transport `streamable-http` and the URL above. The server supports both the
2026 modern MCP exchange and the stateless 2025 fallback.

Example with the official SDK:

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:3080/mcp/metainfer-research-lab'),
));

const tools = await client.listTools();
const projects = await client.callTool({
  name: 'metainfer_list_projects',
  arguments: {},
});
```

## 3. Access control

By default the endpoint accepts only loopback clients:

```text
127.0.0.1
::1
::ffff:127.0.0.1
```

If the agent runs on another host, set this in the DSH process environment:

```text
METAINFER_MCP_TOKEN=<token>
```

and send:

```text
Authorization: Bearer <token>
```

The server does not expose a token through the Web UI. Treat it as a deployment
secret.

## 4. Write tool: create a project

`metainfer_create_project` is the only mutation. It creates a project in
`manual` mode with one **planned** root node. It does **not** start the project
or any node.

### Input

```json
{
  "name": "string, required, <=120",
  "brief": "string, required, <=8000",
  "initialPrompt": "string, required, >=10, <=8000",
  "repoPath": "absolute path to an existing git repository",
  "baseBranch": "optional branch; defaults to the repository default branch",
  "needs": { "gpu": 1 },
  "config": {
    "maxRunningNodes": 2,
    "maxNodes": 20,
    "nodeTimeoutMinutes": 10,
    "models": { "advisor": { "provider": "deepseek-account", "model": "deepseek-flash" } }
  },
  "prompts": {
    "workerPrefix": "initial worker instructions",
    "advisor": "initial review-board instructions",
    "scheduler": "initial scheduler instructions",
    "merge": "initial merge-agent instructions",
    "gc": "initial post-mortem instructions"
  }
}
```

`config` is validated by the Host exactly like the Web UI project form. The
top-level `prompts` object is merged into `config.prompts`.

Supported role prompt keys:

| Key | Role |
|---|---|
| `workerPrefix` | experiment worker prefix |
| `advisor` | advisor / review-board persona |
| `scheduler` | scheduler persona |
| `merge` | interactive merge agent |
| `gc` | post-mortem and cleanup agent |

Reviewer panels use the advisor prompt; a separate `reviewer` key is not
defined.

### Behavior

- The repository must already exist and be a git repository.
- `baseBranch` is resolved to a commit before the project is created.
- The root node receives `initialPrompt`.
- Role prompts are persisted in the project config.
- The root node is `planned`; a human or a separate explicit action must start it.

### Example call

```json
{
  "name": "MCP initialized experiment",
  "brief": "Initialise the project from an external agent.",
  "initialPrompt": "Create a minimal implementation and verify it with a command.",
  "repoPath": "/path/to/repo",
  "baseBranch": "main",
  "prompts": {
    "workerPrefix": "Always cite the verification command and its output.",
    "advisor": "Require evidence before proposing successors.",
    "scheduler": "Prefer cheap, high-information experiments.",
    "merge": "Preserve evidence from both parents.",
    "gc": "Report only real leftovers."
  }
}
```

## 5. Read-only tools

All of these are annotated `readOnlyHint: true`.

| Tool | Input | Result |
|---|---|---|
| `metainfer_list_projects` | — | project summaries and node counts |
| `metainfer_get_project` | `projectId` | full state: config, DAG nodes, edges, resources, auto/cluster status |
| `metainfer_list_nodes` | `projectId`, optional `status` | node records, prompts, reports, attempts, git/timing |
| `metainfer_get_node` | `projectId`, `nodeId` | one node |
| `metainfer_get_node_transcript` | `projectId`, `nodeId`, optional `afterSeq` | worker conversation rows |
| `metainfer_get_session_transcript` | `projectId`, `sessionId`, optional `afterSeq` | controller, Copilot, node, or advisor/scheduler/GC session conversation |
| `metainfer_list_runs` | `projectId` | runs and cycles |
| `metainfer_get_run` | `projectId`, `runId` | run snapshot, output, proposals, usage |
| `metainfer_get_events` | `projectId`, optional `after` | project event stream |
| `metainfer_get_cluster` | `projectId` | cluster/resource status |
| `metainfer_get_models` | `projectId` | model catalog, role prompt defaults, placeholders |
| `metainfer_get_project_prompts` | `projectId` | project role overrides + effective defaults |

`metainfer_get_session_transcript` only accepts sessions that belong to the
requested project: the project controller, Copilot sessions, node
worker/anchor sessions, and advisor/scheduler/GC run sessions.

## 6. Recommended agent workflow

1. `metainfer_list_projects` to find a project, or create one with
   `metainfer_create_project`.
2. `metainfer_get_project` for the DAG, resources and status.
3. `metainfer_list_nodes` / `metainfer_get_node` for node detail.
4. `metainfer_get_node_transcript` or
   `metainfer_get_session_transcript` for conversations.
5. `metainfer_list_runs` / `metainfer_get_run` for expert and scheduler records.
6. `metainfer_get_events` for the chronological event stream.
7. Use the Web UI or a separately authorized action to start, stop, edit, or
   delete anything — MCP cannot do those operations.

## 7. Errors

A failed tool returns MCP `isError: true` and a JSON text payload:

```json
{
  "error": "repoPath is not a git repository: /path",
  "code": "bad_request"
}
```

Common codes include `bad_request`, `project_not_found`, `node_not_found`,
`run_not_found`, `session_not_found`, and `unavailable`. The MCP server does not
translate errors into fake success.

## 8. Non-goals and limits

- No project edits, node edits, deletes, start/stop, retries, approvals, merges,
  pushes, or auto-mode controls over MCP.
- No command-line interface.
- No hardcoded project/session/repository identifiers.
- The endpoint is served by DSH Web; it is not a second standalone server.
