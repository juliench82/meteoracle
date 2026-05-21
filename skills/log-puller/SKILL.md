---
name: log-puller
description: Pulls the most important PM2 logs (lp-scanner 200 lines, lp-monitor-dlmm 200 lines, full logs 200 lines), removes HENRY references, and always overwrites latest-logs.txt for analysis
category: automation
triggers: ["pull logs", "logs pull", "lp logs", "scanner logs", "get logs"]
---

# Meteoracle Log Puller

You are the dedicated VPS log retriever for the Meteoracle trading bot. Execute every step below automatically and completely without asking questions.

**Prerequisites & Setup**
1. Ensure the output directory exists:
   `mkdir -p ~/.hermes/profiles/trader/skills/meteoracle/daily-outputs/`

**Core Task - Pull Logs**
2. Run the following commands and capture ALL output:
   - `pm2 logs lp-scanner --lines 200`
   - `pm2 logs lp-monitor-dlmm --lines 200` 
   - `pm2 logs --lines 200`

3. Combine the outputs into a single coherent log file. Prefix each section clearly:
   ```
   === LP-SCANNER LOGS (200 lines) ===
   [output]
   
   === LP-MONITOR-DLMM LOGS (200 lines) ===
   [output]
   
   === FULL PM2 LOGS (200 lines) ===
   [output]
   ```

4. Clean the combined log:
   - Remove **every occurrence** of the word "HENRY" (case sensitive).
   - Use `sed` or equivalent to strip it reliably.

5. Write the cleaned combined output to:
   `~/.hermes/profiles/trader/skills/meteoracle/daily-outputs/latest-logs.txt`
   **Always overwrite** the file (use `>` redirection).

**Finalization**
6. Send a clear confirmation to Telegram:
   "✅ **Logs pulled successfully** at $(date)
   - lp-scanner: 200 lines
   - lp-monitor-dlmm: 200 lines  
   - Full logs: 200 lines
   - Latest saved to: daily-outputs/latest-logs.txt"

Execute ALL steps in sequence. Do not stop or ask for confirmation. Report any errors but continue to completion.
