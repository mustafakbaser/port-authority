## What this changes

<!-- One or two sentences. If it fixes an issue, link it. -->

## Why

<!-- What was wrong, or what was missing. -->

## Checklist

- [ ] `npm run check` passes
- [ ] New logic lives in `src/core` if it does not need the editor API
- [ ] Tests added, including a negative case if this touches port inference or EADDRINUSE detection
- [ ] If this touches the terminate path, the pull request explains which safety property is affected and why
