# Public dashboard screenshots

Refreshed 2026-09-04 from the checked-in synthetic demo and current UI assets.
Analytics refreshed 2026-09-05 to distinguish known sessions from requests with
missing identity; the values remain fictional.
Layout refreshed 2026-09-06: hardening suggestions now belong to the Gate Genie tab,
with the primary Current Jobs / Priority / Reason table and separate scheduling settings.
These are actual browser captures of fictional data, not edited production
screenshots, benchmark results, a live incident report or a promoted model.

- `dashboard-overview.png`: branding, persistent health wire, focused navigation,
  the single-row desktop fleet band, mixed-server
  activity, aligned rounded speeds, requested thinking, compact synthetic RAM /
  GPU / POWER strips, the 12-hour fleet-speed and measured-energy pulse, and the ready Continuity Door
  contract. Decode, Prefill and Cache hits lights open evidence without expanding the card.
- `overview-mobile.png`: the compact status row at 390px, including both calibrated
  speed gauges and their dense value/energy footer.
- `worker-management.png`: the capability-gated Settings view, recommended
  Spark profile, 20,000-hour queue allowance, one synthetic exact queued-handover
  offer with its cache-locality warning, and a synthetic named maintenance lock
  whose exact release cannot resume routing by itself.
- `priority-correction.png`: an explicitly scripted general-rule proposal,
  showing exact removal/addition before confirmation; no live policy change.
- `priority-settings.png`: bounded weight controls and an explicitly selected
  synthetic ten-minute eligible-wait backstop; this is not a production default.
- `dashboard-genie.png`: current jobs and manual priorities, a synthetic pre-dispatch pool assignment receipt, an open assessment, collapsible hardening suggestions below
  the conversation, linked agent enrollment guide, recovery controls and the private
  Gate Genie notebook.
- `dashboard-analytics.png`: operational collection status, calibration skip
  status and cache acquisition calculator.
- `dashboard-activity.png`: Continuity Door rejection evidence and the filtered
  request log, separated from the live fleet view.
- `genie-memory.png`: synthetic worker incident/recovery history and an explicit
  operator note, captured from the real notebook implementation in temporary storage.

## Refresh

Core DSG has no browser dependency. For this optional development task only,
make Playwright available (the checked-in capture tool was tested with 1.62.1):

```sh
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run ui:screenshots
npm run ui:memory-screenshot
```

Alternatively set `DSG_PLAYWRIGHT_MODULE` to an already-installed Playwright module
entry file; no package installation in this checkout is then necessary.
`DSG_SCREENSHOT_CHANNEL=chrome` uses installed Chrome in a separate, temporary
headless profile instead of downloading Chromium. It does not attach to your
normal browser session. The checked-in images were captured with this option.
The script launches its **own synthetic server on an ephemeral loopback port**;
it accepts no production dashboard URL, loads no private config/logs and blocks
non-demo browser requests. No model, encoder, trainer, SSH connection or Genie
inference runs. Interactive `npm run ui:demo` uses the same fixture on port 30011.
Recovery mutations are intentionally rejected in the demo.
Reset and milestone dismissal manipulate synthetic in-memory UI fixtures only.
The separate notebook fixture creates its own disposable private directory. It
checks persistence by restarting only its synthetic dashboard, then removes that
test directory. It never reads or modifies the deployed notebook.

The capture uses 1440px width, UTC, en-US and reduced motion so headlines are
readable. It checks the real logo, exact title, accessible tab and keyboard state,
the far-right Settings tab, a fleet band under 150px tall, populated cards, operational evidence, report persistence across
a real refresh, and a 390px mobile viewport without page-level horizontal overflow.
Timestamps and platform fonts may differ; this is a content/privacy smoke test,
not a pixel-perfect golden-image test.
The worker-management capture creates and releases a synthetic maintenance lock,
proves the card Resume is disabled while held, then proves release leaves an
operator pause and a separate Resume is required. No live worker is involved.

Before committing, visually inspect all changed PNGs and run `npm run check`,
`npm test` and `npm run privacy-check`. Numerical fixture values must remain
invented: never populate them by copying `/api/status`, production request rows,
private hostnames, conversation IDs, model reports or credentials. Do not publish
live UI screenshots without a separate privacy review.

The Fleet overview now includes Decode, Prefill and Cache hits lights. [Performance evidence](images/performance-evidence.png) shows the compact dialog; it does not expand the machine card. Both use scripted numerical fixtures, not a live hardware benchmark.


`temperature-evidence.png` shows synthetic temperature, activity and clock trends
on one wall-clock axis with separate labelled scales and explicit sensor/throttle
status. `energy-evidence.png` shows the selected period, measured subtotal,
per-worker coverage and measurement scope. The capture checks click/Escape and
focus restoration for both dialogs. These are synthetic examples, not production
measurements.
