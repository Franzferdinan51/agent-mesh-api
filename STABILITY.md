# Agent Mesh Stability Guide

## Production Deployment

### PM2 Process Manager (Recommended)

PM2 is a production-grade process manager that provides automatic restarts, monitoring, and log management.

#### Installation

```bash
npm install -g pm2
```

#### Start Agent Mesh

```bash
cd C:\Users\Ryan\.openclaw\workspace\agent-mesh-local
pm2 start server.js --name "agent-mesh" --max-memory-restart 500M
```

#### Configuration Options

| Option | Description | Recommended |
|--------|-------------|-------------|
| `--name` | Process name | `agent-mesh` |
| `--max-memory-restart` | Memory limit before restart | `500M` |
| `--watch` | Auto-restart on file changes | `false` (production) |
| `--restart-delay` | Delay between restarts | `1000` (ms) |
| `--max-restarts` | Maximum restart attempts | `10` |

#### PM2 Commands

```bash
# Check status
pm2 list

# View logs
pm2 logs agent-mesh

# Real-time monitoring
pm2 monit

# Restart service
pm2 restart agent-mesh

# Stop service
pm2 stop agent-mesh

# Remove from PM2
pm2 delete agent-mesh

# Save configuration (persists across reboots)
pm2 save
```

---

## Monitoring Stack

### Layer 1: PM2 (Primary)
- Auto-restart on crash
- Memory limit enforcement
- Process health tracking

### Layer 2: Python Monitor (Backup)
Located at: `C:\Users\Ryan\.openclaw\workspace\agent_mesh_auto_restart.py`

```bash
# Start backup monitor
python agent_mesh_auto_restart.py
```

Features:
- HTTP health check every 60 seconds
- Automatic restart if mesh unresponsive
- Process cleanup before restart

### Layer 3: OpenClaw Cron (Heartbeat)
Configured in HEARTBEAT.md - checks every 15 minutes

### Layer 4: Agent Mesh API
```bash
# Health check endpoint
curl -H "X-API-Key: openclaw-mesh-default-key" http://localhost:4000/api/health/dashboard
```

---

## Troubleshooting

### Service Not Responding

1. **Check PM2 status:**
   ```bash
   pm2 list
   pm2 logs agent-mesh --lines 50
   ```

2. **Check port availability:**
   ```bash
   netstat -ano | findstr :4000
   ```

3. **Manual restart:**
   ```bash
   pm2 restart agent-mesh
   ```

### Port 4000 In Use

```bash
# Find process
netstat -ano | findstr :4000

# Kill process
taskkill /PID <PID> /F

# Restart
pm2 restart agent-mesh
```

### Database Issues

```bash
# Stop service
pm2 stop agent-mesh

# Check database
dir agent-mesh.db*

# Remove lock files
del agent-mesh.db-wal
del agent-mesh.db-shm

# Restart
pm2 start agent-mesh
```

### Memory Leaks

If memory grows continuously:

1. **Check current memory:**
   ```bash
   pm2 describe agent-mesh
   ```

2. **Lower memory limit:**
   ```bash
   pm2 delete agent-mesh
   pm2 start server.js --name "agent-mesh" --max-memory-restart 300M
   ```

3. **Review logs for patterns:**
   ```bash
   pm2 logs agent-mesh | findstr "memory\|error\|warn"
   ```

---

## Windows Event Viewer

Check for silent crashes:

```
1. Open: eventvwr.msc
2. Navigate: Windows Logs → Application
3. Filter: Source = Node.js
4. Look for: Crashes, errors, warnings
```

Common errors:
- `EADDRINUSE` - Port conflict
- `ENOMEM` - Memory exhaustion
- `ECONNRESET` - Network issues

---

## Best Practices

### Do:
- ✅ Use PM2 for production
- ✅ Set memory limits (300-500MB)
- ✅ Monitor logs regularly
- ✅ Keep backup monitor running
- ✅ Save PM2 configuration

### Don't:
- ❌ Run with `node server.js` in production
- ❌ Ignore repeated crashes
- ❌ Set memory limits too high
- ❌ Disable auto-restart

---

## Support

**Agent Mesh Repository:** https://github.com/Franzferdinan51/agent-mesh-api

**OpenClaw Docs:** https://docs.openclaw.ai

**Last Updated:** 2026-02-13
