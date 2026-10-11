---
name: system-info
description: "Inspect operating system version, CPU, memory, disk usage, processes, battery, and network or port status. Use when the user asks about their computer's health, capacity, or a resource bottleneck; gather read-only evidence before proposing changes."
allowed-tools:
  - Bash
---

# System Information

Use `Bash` for the smallest read-only probe that answers the question. Detect the operating system first and select supported commands; macOS and Linux command options differ.

## macOS probes

| Question | Command |
| --- | --- |
| OS version | `sw_vers` |
| CPU architecture and core count | `uname -m` and `sysctl -n hw.ncpu` |
| Physical memory and VM statistics | `sysctl -n hw.memsize` and `vm_stat` |
| Volume free space | `df -h` |
| Size of a requested directory | `du -sh '<directory>'` |
| Processes ordered by CPU | `ps -Ao pid,pcpu,pmem,comm -r` |
| Processes ordered by memory | `ps -Ao pid,pcpu,pmem,comm -m` |
| Listener on a known port | `lsof -nP -iTCP:<port> -sTCP:LISTEN` |
| Battery and power source | `pmset -g batt` |
| Uptime and load | `uptime` |

Replace placeholders with the actual requested path or port and quote paths safely. Bound process output to the relevant entries. On Linux, use supported equivalents such as `uname`, `free`, `df`, and `ps` after checking availability.

## Interpret results

- Label units and the sampling time. Convert `vm_stat` counts using its reported page size; free pages alone do not measure macOS memory pressure.
- Distinguish a point-in-time CPU sample from sustained load. A process name or high memory use alone does not prove a leak.
- Disk-full evidence should identify the affected volume. A directory total may be incomplete when access was denied.
- For connectivity, inspect the requested interface or endpoint. A successful ping to one host does not prove that DNS, HTTPS, or the user's service works.
- Avoid full environment dumps, credential files, process arguments containing tokens, and hardware serial numbers.

Report unavailable commands or denied access. Diagnosis does not authorize killing processes, changing networking, installing software, or deleting files.
