# pi-schedule

Durable reminders and repeating prompts for a Pi session, built on `pi-durable`. Schedules survive restarts: each one is a durable task asleep in a SQLite store next to the session. A time that passes while Pi is closed fires once when the session opens again; a repeating schedule then moves to its next slot instead of firing every missed one.

```sh
cd ~/Work/pi-extension/pi-schedule && npm install --legacy-peer-deps
pi install ~/Work/pi-extension/pi-schedule
```

- `/schedule in 30m <prompt>`: send `<prompt>` once, in 30 minutes.
- `/schedule every 2h <prompt>`: send it every two hours.
- `/schedule list`, `/schedule cancel <id>`.

Durations run from 1m to 366d with units `m`, `h`, `d`. A due prompt is sent as a user message once Pi is idle, so it never interrupts a run. Schedules belong to the session: resume the session (`pi -c`, `/resume`) to keep them firing. One process may own a session's schedules at a time.
