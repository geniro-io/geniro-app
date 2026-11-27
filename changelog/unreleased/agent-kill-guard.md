### Fixed

- An agent's cleanup can no longer close every app on your Mac: its shell refuses a `kill` aimed at PID 1, at all your processes or at more than 60 processes at once
