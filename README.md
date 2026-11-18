# token-radar-v2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Nugroho281/token-radar-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Nugroho281/token-radar-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Sightline prices 198 pre-token protocols off 128 traded comps in the same snapshot: a log-log size curve plus a 7-day growth term that survived walk-forward term selection (out-of-sample median error 0.447 vs 0.721 for a flat multiple, confirmed on blind holdouts), with 200-refit bootstrap bands and rank ranges, and a farm plan on every row netted to farm, thin or skip.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=scz7tdtw&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
