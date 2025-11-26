# Overdue Behaviour – Deep Dive

This document focuses exclusively on how overdue numbers are detected, prioritized, and capped inside the Predictor. Use it when you need to reason about “gap-driven” logic without re-reading the entire Predictor overview.

---

## 1. Definition of “Overdue”

- A number is considered **overdue** when its “gap” (spins since it last appeared) is **40 or higher**.
- The gap value comes from `gapStatsExtended`, which tracks both the latest “since” gaps and the historical median gaps.
- Orange and Red numbers are excluded globally, so they never count toward overdue logic.

> **Note:** The same threshold (gap ≥ 40) is used by Smart Overdue, the Pattern C builder, and the final global cap. We avoid mixed definitions to keep the system predictable.

---

## 2. Where Overdue Shows Up

| Layer | How overdue is used | Guardrails |
| --- | --- | --- |
| **Pattern C pool fill** | If the pool still needs numbers, add the longest-gap candidates first. | Hard cap of **4** “pure gap” adds; after that, we fall back to non-overdue logic so the pool is not flooded. |
| **Smart Overdue** | Context-aware injection that looks for overdue candidates with 40%+ success in similar color contexts. | Adds **at most 1** number and only if there is still room in the pool. |
| **Gap Pressure scoring factor** | Weighted component (now **0.18**) in the multi-factor score. | Weight reduced so overdue does not dominate the ranking. |
| **Global selection cap** | After ranking, the final 13 (Top 5 + Cold 8) can contain **no more than 4 overdue numbers**. | Top 5 stay untouched; replacements happen only in cold positions, starting from the lowest ranks. |

---

## 3. Pattern C Pool Builder

1. Run transitions and reactivation logic as usual.
2. If Pattern C is active and the pool still has gaps:
   - Sort remaining candidates by gap descending.
   - Add them one by one **up to a cap of 4** (the value used in code is `MAX_PURE_GAP_CANDIDATES = 4`).
3. If the pool is still short after the cap:
   - Use the normal fallback logic (opposite parity/size, generic fillers) rather than more overdue numbers.

**Why?** Pattern C was previously overwhelming the pool with overdue picks, which then cascaded down into scoring and final selection. The cap keeps the overdue influence intentional but bounded.

---

## 4. Smart Overdue – The “Brains”

Smart Overdue is run **after** the pattern-specific pool logic and **before** the final generic fill.

- Uses the same gap threshold (≥ 40) but requires:
  - At least 6 global overdue candidates.
  - Each candidate to have ≥ 10 historical “overdue hits” in the same previous-color context.
  - Success rate ≥ 40%.
- Ranks by success rate, then by gap.
- Adds **only one** candidate.

Smart Overdue is intentionally late in the pipeline so it remains the *primary* way a deep-overdue idea enters the pool.

---

## 5. Gap Pressure Weight Tuning

- Previous weight: **0.22** of the total score.
- New weight: **0.18** with small compensating boosts to Color Balance (0.16) and Quad Parity (0.10).

Rationale: overdue numbers were landing in the Top 5 too easily because the weight pushed high-gap entries up the ranking curve. The lower weight still rewards gaps, but it no longer crowds out balance-oriented signals.

---

## 6. Global Overdue Cap (Max 4)

After scoring and sorting:

1. Top 5 hot numbers are fixed—**never** reordered or swapped in this step.
2. The remaining 8 cold slots get adjusted if necessary:
   - Count total overdue numbers in the 13.
   - If the count is ≤ 4, do nothing.
   - If > 4, compute how many hot numbers are overdue and allow only the remainder in the cold section.
   - Replace excess overdue cold numbers, starting from the lowest-ranked positions, with the best available non-overdue candidates from the remaining ranked list.
3. If there are not enough non-overdue candidates to satisfy the cap, the system keeps the highest-quality mix available but logs the failure.

This final guardrail ensures the output has a healthy mix of signals even when the environment is strongly gap-biased.

---

## 7. FAQ

**Q: Why not remove Pattern C entirely?**  
A: Pattern C remains valuable when gaps truly matter. The cap mechanism lets us benefit from overdue pressure without letting it dominate.

**Q: Why 40 spins?**  
A: The historical analytics showed that gap ≥ 40 is where “meaningfully overdue” behaviour starts. Using the same threshold everywhere keeps reasoning consistent.

**Q: Can the cap break when almost every candidate is overdue?**  
A: In extreme edge cases there may be fewer than 9 non-overdue numbers available. In that scenario, the system keeps as many non-overdue replacements as possible and emits a diagnostic log so we can investigate.
