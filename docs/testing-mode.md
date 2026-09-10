# Testing through DSG

Use the **Testing** switch in the dashboard header.

When enabled, the banner contains a selectable Testing base URL and a **Copy URL** button. See [Consecutive conversation turns](conversation-turns.md) for the default five-turn allowance and the conversation header needed to test it from Hourglass.

- **On:** new inference requests at the normal endpoint wait at the front door. Requests already admitted continue normally. Genie starts no new reviews, fallback inference or actions; a review already running may finish.
- **Testing endpoint:** `http://127.0.0.1:30000/testing/v1`. It uses the same DSG credential, routing, model aliases, queues, protections and response forwarding as the normal endpoint. Only the `/testing` path prefix is removed. Nothing rewrites sampling or reasoning settings.
- **Off:** new testing requests are rejected before forwarding. Accepted testing work may finish. Waiting normal requests resume. Genie retains its previous enabled/disabled preference.

The banner shows normal requests waiting and whether existing work is still finishing. Wait for existing work to finish before starting a measurement if it must not overlap. Worker routing and pauses remain normal DSG controls; Testing does not enable a paused worker or select a model for you.

## Hourglass connection

Set the base URL to `http://127.0.0.1:30000/testing/v1`, use the existing DSG credential, and choose the actual backend/runtime and its reviewed model profile. For an explicit backend target, configure an explicit single-worker DSG route, for example:

| Route / x-dsg-model value | Worker |
|---|---|
| spark1 | Spark 1 |
| spark2 | Spark 2 |
| m3-studio | M3/oMLX |

For example, with a Spark worker serving Qwen through vLLM: backend **vLLM**, body model `qwen3.8-flash-next`, DSG route `spark1`. Enable routing for Spark 1 using its existing control if it is paused. Sampling/thinking choices remain in Hourglass's reviewed profile. The testing URL also supports other normal DSG API paths, including completions, responses, messages and model discovery. Routes do not bypass worker health or pauses. A missing route header uses ordinary pool routing.

For another client, send `x-dsg-model: spark1` on every request to pin Spark 1. Do not put a backend API credential in that header. Localhost refers to the machine running DSG; remote clients need their existing authorized connection.

## Persistence and boundaries

Testing mode is stored in `runtime/testing-mode.json` beside DSG's state. The Door owns changes; Genie reads the state before starting work. Dashboard and Door restarts retain the mode. An unreadable state suspends new Genie work and prevents a new Door from assuming testing is off.

The waiting requests are live connections, held without reading/persisting their bodies and without replay. They remain subject to client/network timeouts and the existing finite Door hold capacity. Closing a client removes its waiting request. A Door restart cannot preserve those TCP connections; queued work receives the existing not-forwarded shutdown response. Maintenance holds remain independent and cannot be lifted by the Testing switch. Direct connections to a model server or the private core bypass the public Door and are outside Testing.

Existing vision compatibility protections are unchanged, including their documented recovery transformations; Testing is not an opt-out or a new scheduling lane inside the gateway. No Pi extension is used.
