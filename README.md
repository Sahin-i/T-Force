# T-force

A hackathon project for office work: describe a procedure, test it against documents, review the results, and approve a simulated business action. The app combines a React interface, a Fastify backend, Azure OpenAI, and disposable Docker sandboxes.

Agent tools are `read`, `write`, `edit`, and `bash`. Published workflow versions are immutable. Approval is tied to the current case revision and verified artifacts; queues prevent duplicate entries. All bundled company records and policies are fictional, and payments, provisioning, and correspondence are simulated.

## Requirements

- Node.js 22.12 or newer (Node.js 24 is used in CI).
- npm and a running Docker engine.
- An Azure OpenAI endpoint, API key, and deployment for conversational authoring and AI tasks. The imported Python invoice example can run without Azure credentials.

## Quick start

Run from the repository root:

```sh
npm ci
npm run sandbox:build
npm run build
npm start
```

Open http://127.0.0.1:3001. The backend serves both the built frontend and API.

For development, run `npm run dev` and open http://127.0.0.1:5173. Vite proxies API requests to port 3001.

## Configuration

This public copy includes no `.env` files or credentials. Configure the backend with environment variables. You may create an ignored local `.env` yourself; `dotenv` loads it automatically. Put real values only in your local configuration or the runtime's secret store.

| Variable | Purpose / default |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI resource endpoint; no default |
| `AZURE_OPENAI_API_KEY` | Your Azure API key; no default |
| `AZURE_OPENAI_DEPLOYMENT` | Your model deployment name; default `gpt-6-luna` |
| `PORT` | Backend port; default `3001` |
| `SANDBOX_IMAGE` | Docker sandbox image; default `office-agent-sandbox:local` |
| `DEFAULT_SQLITE_DATABASE` | Workspace-relative database; default `data/office.sqlite` |
| `MAX_ITERATIONS` | Maximum agent iterations; default `20` |
| `MAX_RUN_MS` | Run deadline in milliseconds; default `600000` |
| `COMMAND_TIMEOUT_MS` | Tool command deadline; default `120000` |
| `MAX_TOOL_OUTPUT_BYTES` | Tool output limit; default `65536` |
| `MAX_CONTEXT_BYTES` | Context limit; default `1000000` |
| `MAX_OUTPUT_TOKENS` | Model output limit; default `12000` |
| `MODEL_RETRIES` | Model retry count; default `2` |

Credentials are read by the backend. Frontend `VITE_` variables are included in the browser bundle, so never use them for credentials. The Azure client uses the resource's `/openai/v1/` Responses endpoint; a legacy `AZURE_OPENAI_API_VERSION` variable is not used by that client.

## Try the invoice demo without Azure

1. Build the sandbox and start the app.
2. Open **Create workflow → Import workflow** and choose `catalog/simple-invoice/reviewed-package.json`.
3. Run its sample test with `catalog/simple-invoice/invoice.pdf` and `catalog/simple-invoice/purchase-order.pdf`.
4. Inspect the summary, explicitly review, and publish the workflow.
5. Run a case with the same documents and approve the matching invoice. Use `catalog/simple-invoice/mismatch/invoice.pdf` to check discrepancy blocking.

Import creates a fresh draft and does not bypass testing, publication, or approval. The reviewed procedure is a disclosed team code-review repair of an AI-generated starter. It handles the supplied labelled PDF layout and rejects ambiguous or unsupported input. Python-only tasks run with networking disabled. Azure authoring and AI tasks send relevant document content to your configured Azure service.

## Validation

```sh
npm test
npm run build
# Requires Docker and the built sandbox image:
npm run test:docker
npm run test:e2e
```

Some document tests require Python with the libraries in `sandbox/requirements.txt`. Install them in a virtual environment and set `WORKFLOW_TEST_PYTHON` to its Python executable. CI installs those libraries before running tests and the production build.

GitHub Actions runs build and unit checks on pushes and pull requests without Azure credentials. Docker integration checks can be run locally with the commands above.

## Hosting and persistence

This is a local application. It binds to `127.0.0.1`, checks localhost Host/Origin headers, and has no multi-user authentication. The production build is ready to run on a machine with Node.js and Docker. GitHub Pages cannot run its backend or Docker tools. Public web hosting requires an authentication and deployment design before changing these access controls.

Run `npm start` from the repository root after building the app and sandbox. Supply backend credentials through the host's environment and retain `workspace/` and `.agent-state/` on persistent storage. `GET /api/health` reports Docker readiness, Azure configuration status, and database availability. Stop with SIGINT or SIGTERM for orderly cleanup.

The app creates these private runtime directories automatically:

```text
workspace/       uploaded files, outputs, scratch files, and the shared task database
.agent-state/   chats, runs, workflow metadata, protected inputs, and approval records
```

## Public repository contents

This copy contains source, locked dependencies, tests, sandbox configuration, and synthetic catalog examples. Local credentials, Git history, application state, uploaded/generated workspace files, build outputs, screenshots, recordings, presentation artifacts, and historical setup/demo transcripts were excluded. All `.env*` files are excluded, including example files. `.gitignore` and `.dockerignore` protect these paths.

The advanced evaluation and historical submission scripts remain available, but scripts that consume past validation records need those records generated locally. See `catalog/README.md` for catalog methods. Historical evidence and presentation packages from the original working folder are not included in this source release.
