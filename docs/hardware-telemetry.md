# Optional hardware telemetry

DSG can observe a small, low-rate hardware schema without changing DS4. This
feeds the compact per-server **RAM / GPU / POWER** strips and, when every current
server has sufficiently dense whole-device measurements, the fleet pulse's
estimated kWh and tokens/kWh.

The feature is off until it is explicitly configured in the ignored private
`config.local.json`. It grants no routing, restart, recovery, shell or model-
setting power. Activating or changing it needs only a dashboard reload; the
gateway core and DS4 servers do not need a restart.

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

The adapter opens a persistent batch-mode SSH observer and runs one fixed,
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
It also does not fall back from module power to a GPU-only or TDP figure. See the
official [`nvidia-smi` field definitions](https://docs.nvidia.com/deploy/nvidia-smi/index.html).
Unsupported fields stay unknown. The observer uses a bounded line buffer, a
no-sample watchdog and reconnect delay. It does not invoke DS4 or touch its
service.

## Generic local JSONL adapter

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
- power: `compute_module` or `system`;
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
