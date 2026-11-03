# Agents and systemd

Give each agent its own worktree and preview, and you can watch every branch running at once:

```sh
# one worktree and one preview per agent task
for task in login billing search; do
  git worktree add -b "agent/$task" "../app-$task"
  wtp up "../app-$task" --install --json >> previews.jsonl || echo "agent/$task failed to start" >&2
done

# every running preview, ready for a script or a dashboard
wtp ls --json | jq -r '.[] | select(.state == "up") | "\(.branch)\t\(.url)"'

# when an agent is done
wtp down ../app-login && git worktree remove ../app-login

# end of the day: stop all previews, and clear out any whose worktree is gone
wtp down --all
wtp gc --worktrees-gone
```

For unattended use:

- A fresh worktree has no `node_modules`. Pass `--install` (or set `"install": true` in `.worktree-preview.json`) so the first `wtp up` installs before it starts.
- `wtp up` is idempotent, so an agent can call it every time without checking first.
- A preview survives the agent's shell exiting. `wtp ls` lists every one and `wtp down --all` stops every one, so nothing gets orphaned.
- When the server will not start, `wtp up` exits 1 with the log tail on stderr. A failed start is a failed command, not a hang.
- Pass `--wait` for slow builds, or set `ready_timeout` in the config so every agent gets the same value.

## Running under systemd

`examples/systemd/wtp@.service` is a user unit that ties a preview to the unit's lifetime:

```sh
cp examples/systemd/wtp@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start "wtp@$(systemd-escape --path /path/to/worktree).service"
systemctl --user stop  "wtp@$(systemd-escape --path /path/to/worktree).service"
```

`wtp up` exits once the server is ready, and the server keeps running in the unit's cgroup (`RemainAfterExit=yes`). Stopping the unit runs `wtp down`, and systemd sweeps whatever is left in the cgroup. I tried it with a transient unit that had `PrivateTmp=yes`: the preview was visible from a normal shell, and stopping the unit left no process behind. The unit does not restart anything. If the server crashes, run `wtp up` again.


