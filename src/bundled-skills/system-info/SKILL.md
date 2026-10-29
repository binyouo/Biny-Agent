---
name: system-info
description: Get system information — OS version, disk usage, memory, running processes, network status. Use when users ask about their computer status or system health.
allowed-tools:
  - Bash
---

# System Info Skill

Gather system information using standard command-line tools.

## Commands

```bash
# OS version
sw_vers                              # macOS
uname -a                             # Any Unix

# Disk usage
df -h                                # All volumes
du -sh '<requested-directory>'       # Only the directory relevant to the request

# Memory
vm_stat                              # macOS memory stats
top -l 1 -s 0 | head -12            # Quick system overview

# CPU
sysctl -n machdep.cpu.brand_string   # CPU model
sysctl -n hw.ncpu                    # CPU count

# Running processes (top CPU/memory)
ps -Ao pid,pcpu,pmem,comm -r | head -11  # Top CPU (macOS)
ps -Ao pid,pcpu,pmem,comm -m | head -11  # Top memory (macOS)

# Network
ifconfig | grep "inet "              # IP addresses
networksetup -listallhardwareports   # Find the actual Wi-Fi interface first
networksetup -getairportnetwork <wifi-interface>  # Substitute its Device value
ping -c 1 8.8.8.8                    # Connectivity check

# Battery (MacBook)
pmset -g batt                        # Battery status

# Uptime
uptime
```

## Tips
- Use `sw_vers` for macOS version details
- For hardware details, use `uname -m`, `sysctl -n hw.ncpu`, and `sysctl -n hw.memsize`; avoid printing serial numbers or identifiers.
- Use `lsof -nP -iTCP:<port> -sTCP:LISTEN` for a requested listening port.

## Interpret Results

- These examples target macOS; check the platform before using them. On Linux, use supported equivalents such as `uname`, `free`, `df`, and the platform's `ps` options.
- Label units and sampling time. Convert `vm_stat` pages using its reported page size; free pages alone do not establish memory pressure.
- A point-in-time CPU sample does not establish sustained load, and high memory use alone does not prove a leak.
- Report access-denied paths and unavailable commands. A directory total may be incomplete.
- A successful ping to one host does not prove DNS, HTTPS, or the user's service works. Check the relevant endpoint.
- Avoid environment dumps and process arguments that may expose credentials. Diagnosis alone does not authorize killing processes, changing networking, or deleting files.
