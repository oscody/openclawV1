Active branch: main-with-usage
Sync upstream releases: git fetch upstream then merge into main, then merge main into main-with-usage
Push to fork: git push origin main-with-usage
After any code change: NODE_OPTIONS=--max-old-space-size=2048 pnpm build then systemctl --user restart openclaw-gateway
Build control UI separately if needed: pnpm ui:build (not included in the main build step)
