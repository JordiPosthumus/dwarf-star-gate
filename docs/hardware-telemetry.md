# Optional hardware telemetry

DSG can observe a small, low-rate hardware schema without changing DS4. This
feeds the compact per-server **RAM / GPU / POWER** strips and, when every current
server has sufficiently dense whole-device measurements, the fleet pulse's
estimated kWh and tokens/kWh.

The feature is off until it is explicitly configured in the ignored private
`config.local.json`. It grants no routing, restart, recovery, shell or model-
setting power. Activating or changing it needs only a dashboard reload; the
gateway core and DS4 servers do not need a restart.

## Operational measurements

Hardware collection feeds the dashboard, measured energy and performance
evidence. The former model-feature snapshot bridge has been removed.

## DGX Spark / NVIDIA Linux

An enrolled worker with an existing, host-key-verified `ssh` alias can use the
built-in NVIDIA Linux adapter:

```json
"hardware_telemetry": {
  "enabled": true,
  "interval_ms": 10000,
  "workers": {
    "spark1": { "adapter": "nvidia-linux" },
    "spark2": { "adapter": "nvidia-linux" }
  }
}
```

The base adapter opens a persistent batch-mode SSH observer and runs one fixed,
repository-owned command. Configuration cannot supply a command or SSH option.
It samples:

- `MemTotal` and `MemAvailable` from `/proc/meminfo`, labelled **unified host
  memory** rather than GPU RAM;
- `utilization.gpu`, labelled as the share of the sample period with GPU kernels
  executing;
- the current SM clock where supported;
- `module.power.draw.instant` where supported, labelled **compute module** power.

DSG deliberately does not use `nvidia-smi` framebuffer memory on DGX Spark as a
stand-in for unified memory: NVIDIA documents that reading as unsupported on
Spark in its [known issues](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html).
For energy totals it does not substitute GPU-only power or TDP for module power.
GPU-only measurements can still be displayed with their narrower scope. See the
official [`nvidia-smi` field definitions](https://docs.nvidia.com/deploy/nvidia-smi/index.html).
Unsupported fields stay unknown. The observer uses a bounded line buffer, a
no-sample watchdog and reconnect delay. It does not invoke DS4 or touch its
service.

A second fixed read-only observer queries GPU temperature and the driver's
hardware/software thermal-slowdown flags once per minute. This preserves the
existing RAM/GPU/power/clock command and cadence. Temperature has independent
freshness (120 seconds) and a bounded 15-minute history; it never refreshes stale
power. Unsupported temperature or flags remain unknown. Closing or removing a
worker closes both observers. The compact temperature control opens sensor,
time and throttling evidence; temperature alone does not establish a cooling
fault. Compare GPU temperature, activity and clock under similar load; ambient
conditions and CPU temperatures cannot be assumed equivalent.

### Missing power despite working GPU and RAM readings

A supported query name does not guarantee a measurement: a driver can return
`[N/A]` for both module power fields while reporting utilization and clocks.
The narrower `power.draw` GPU reading is not interchangeable with module or
wall power. The adapter now uses it when module power is unavailable, explicitly
labelled **GPU only** and excluded from fleet kWh. If both are unavailable, power
stays unknown. RAM/GPU/clock charts can work while energy remains unavailable. Check the exact query
result before treating a blank power chart as a stopped collector. Do not use a
configured power limit or TDP as if it were a measured draw.

## Generic local JSONL adapter

### Built-in unprivileged Mac adapter

For a DS4 worker running on the **same Mac as the dashboard**, explicitly enroll
`"m3-studio": { "adapter": "macos-local" }` in the workers map. It reads host
occupied RAM (`total memory − free memory`, including reclaimable caches) and
the single AGX driver's reported device-utilization percentage. RAM occupancy is
not memory pressure, and GPU activity is not request attribution. Missing or
ambiguous driver readings remain unknown. A fixed, unprivileged AppleSMC helper
reads system-total power (`PSTR`), one GPU temperature (`Tf14`) and one CPU
temperature (`Tf04`). It accepts only supported finite sensor values; missing keys
and zero sentinel values remain unknown. These sensor identities follow the
[Stats sensor definitions](https://github.com/exelban/stats/blob/master/Modules/Sensors/values.swift);
they are not a utility-meter calibration or a CPU/GPU package average.
The helper uses the existing Command Line Tools Python interpreter; no installation
prompt, sudo, powermetrics or SMC write operation is used. Missing interpreter or
SMC access leaves power/temperature unknown while RAM/GPU queries continue.
It does not estimate clocks or modify DS4. SSH-backed workers are rejected rather
than mistakenly assigned the dashboard host's readings. Queries are asynchronous,
bounded to four seconds each (4 MiB for AGX, 16 KiB for SMC), and polling calls never overlap. Closing the observer cancels its
pending query. Unsupported platforms remain explicitly unavailable.

### Existing numerical-file producer

For a Mac, external wall-power meter, or another platform-specific collector,
DSG can tail an already-existing local JSONL file:

```json
"hardware_telemetry": {
  "enabled": true,
  "interval_ms": 10000,
  "workers": {
    "m3-studio": {
      "adapter": "jsonl-file",
      "path": "./runtime/hardware/m3-studio.jsonl"
    }
  }
}
```

Each line is one numerical sample. Omit anything the producer cannot measure:

```json
{"time":1788523200000,"memory_used_bytes":103079215104,"memory_total_bytes":206158430208,"memory_scope":"host_unified","accelerator_activity_pct":61,"accelerator_scope":"accelerator","power_watts":74.2,"power_scope":"system","clock_mhz":1180,"clock_scope":"accelerator"}
```

Allowed scopes are:

- memory: `host` or `host_unified`;
- activity: `gpu_kernel_time` or `accelerator`;
- power: `compute_module`, `system`, or `gpu_only` (display only, excluded from fleet energy);
- clock: `sm` or `accelerator`.

DSG does not ship or silently launch a privileged macOS power collector. A
producer is a separate, deliberate operator enrollment. The file must be a
readable regular file, not a symlink. Reads, partial lines, sample history and
field ranges are bounded. Unknown keys and raw text are discarded; the file path
and source rows never enter status, diagnostics, the Genie briefing or saved
metrics.

## Honest energy boundary

Only `compute_module` and `system` watts are integrated. Samples more than one
minute apart are never bridged. DSG extrapolates a selected 1h/12h/24h fleet
total only after every current registered server has at least 80% measured power
coverage. Until then the UI says **energy awaiting power data**. This favors an
honest unknown over a visually satisfying but incomplete electricity estimate.

Run `npm run doctor` after editing configuration. It validates the adapter map
without connecting to any server, and warns about missing workers, SSH transports
or local files. Unit and browser fixtures cover partial/missing fields, stale
samples, path and route privacy, fixed SSH arguments, whole-device power scopes
and the compact UI.

## Source validation

The Mac adapter was directly exercised with three real samples 15 seconds apart:
172.35, 172.10 and 173.64 W, each collected in 27–43 ms while retaining RAM and GPU
activity. GPU sensor readings were 67.20–69.02 °C and CPU readings 62.41–65.47 °C.
The measured 30.075-second interval integrated to 0.001441509 kWh, agreeing with
an independent trapezoidal calculation to floating-point rounding. This short
check correctly produced no full-hour estimate. It validates local collection;
it does not demonstrate production enrollment or a restarted dashboard. No DS4
process, model setting or cache was changed for this check.
