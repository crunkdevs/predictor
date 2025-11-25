# Learning from Wrong Predictions

## Overview
The system has multiple learning mechanisms that adapt based on prediction outcomes (both correct and wrong). This document explains how the system learns from feedback.

---

## 1. Streak Tracking & AI Triggering

### How It Works
When a prediction is wrong, the system tracks **wrong streaks** per window in the `updateStreak()` function (`src/services/window.service.js` line 243-291).

**Process:**
```javascript
if (correct === false) {
  wrong_streak += 1;
  correct_streak = 0;
} else if (correct === true) {
  correct_streak += 1;
  wrong_streak = 0;
}
```

### Behavior

**Local Predictions:**
- ⚠️ **Never pause or stop** - they continue making predictions regardless of wrong_streak
- If `wrong_streak >= 3`, the system triggers AI instead of local (checked in `shouldTriggerAI`)
- Local predictions are **not blocked** by pause state (see `canPredict` line 217-221 in `window.service.js`):
  ```javascript
  if (ws.paused_until && now < new Date(ws.paused_until)) {
    if (channel === 'ai') {  // Only blocks AI
      return { can: false, reason: 'paused' };
    }
  }
  ```

**AI Predictions:**
- If AI gets 3+ wrong in a row (checked in `updateStreak` line 268-287), it gets paused for **10 minutes** (WRONG_PAUSE_MIN default)
- AI predictions are blocked when window is paused
- Separate AI cooldown: if AI has 3+ consecutive wrongs, it gets a **120 minute cooldown** (AI_STREAK_COOLDOWN_MIN) before it can be triggered again

**Correct Prediction:** Resets wrong streak to 0

### Impact
- Local predictions never stop
- AI predictions pause for 10 minutes after 3+ wrong, and have a 120 minute cooldown
- When local predictions struggle (wrong_streak >= 3), the system switches to AI, but local keeps running

---

## 2. Transition Learning

### How It Works
Every outcome (correct or wrong) updates **transition tables** that track which numbers follow which numbers. This happens in `handleOutcome()` function (`src/services/analyzer.v2.service.js` lines 478-510).

**Process:**
```javascript
// Updates global transitions
INSERT INTO number_transitions (from_n, to_n, count)
VALUES (prevResult, actualResult, 1)
ON CONFLICT DO UPDATE SET count = count + 1

// Updates window-specific transitions
INSERT INTO number_transitions_windowed (from_n, to_n, window_idx, count)
VALUES (prevResult, actualResult, windowIdx, 1)
ON CONFLICT DO UPDATE SET count = count + 1

// Updates cross-window transitions
INSERT INTO window_number_followups (from_window, from_n, to_window, to_n, count)
VALUES (currentWindow, prevResult, nextWindow, actualResult, 1)
ON CONFLICT DO UPDATE SET count = count + 1
```

### Behavior
- **Wrong predictions still teach:** The actual result is always recorded
- **Window-specific learning:** Transitions are tracked per time window (0-11)
- **Cross-window learning:** Tracks transitions from one window to the next (e.g., what number appears in window 3 after a number in window 2)

### Impact
Future predictions use this historical data to build better number pools. Wrong predictions contribute to learning.

---

## 3. Reactivation Learning (Pattern Snapshots)

### How It Works
When reactivation is used (past successful pattern matched), the system tracks whether it worked. This happens in `handleOutcome()` function (lines 512-537).

**Process:**
```javascript
// Records outcome for the snapshot used
INSERT INTO pattern_snapshot_outcomes (snapshot_id, predicted_at, correct)
VALUES (snapshotId, now(), correct)

// Updates hit rate using Exponential Moving Average (EMA)
fn_update_snapshot_hit_rate(snapshotId, correct, 0.2)
```

### Behavior
- **Hit Rate Tracking:** Each snapshot gets a hit rate (0-1) that updates with each use
- **EMA Update:** Uses Exponential Moving Average with alpha=0.2 (defined in `src/migrations/20251018_snapshot_hit_rate.sql`)
  - Correct prediction: `hit_rate = 0.2 × 1.0 + 0.8 × old_hit_rate` (increases)
  - Wrong prediction: `hit_rate = 0.2 × 0.0 + 0.8 × old_hit_rate` (decreases)
- **Future Matching:** Snapshots with higher hit rates get priority in future matches

### Important Note
This only happens **if reactivation was actually used** in the prediction. The code checks if there's a `snapshot_id` in the prediction's summary (line 514-520). If reactivation wasn't used, this step is skipped.

### Impact
The system learns which past patterns are reliable. If a snapshot keeps failing, its hit rate decreases and it won't be used as much in the future.

---

## 4. Rule Weight Adjustment (Legacy/Old System Only)

### Status
⚠️ **This only applies to the old `prediction_logs` table system**, not the current `predictions` table system. This is legacy code.

**Legacy Implementation** (`src/analytics/analytics.migrations.js` - `fn_feedback_apply()`):
```javascript
if (correct === true) {
  weight = LEAST(weight * 1.05, 5.0)  // Increase by 5%, max 5.0
  wrong_streak = 0
} else {
  weight = GREATEST(weight * 0.95, 0.1)  // Decrease by 5%, min 0.1
  wrong_streak += 1
  if (wrong_streak >= 3) {
    disabled = true  // Disable rule after 3 wrong
  }
}
```

**Not used in current system** - The current system uses the `predictions` table, not `prediction_logs`.

---

## 5. Overdue Event Learning

### How It Works
When an overdue number (gap >= 40 spins) finally appears, the system records the context. This happens in `processOutcomeForImage()` function (`src/services/outcome.service.js` lines 112-156).

**Process:**
```javascript
// Calculate gap (how many spins since this number last appeared)
if (gapSpins >= 40) {
  INSERT INTO overdue_events (
    occurred_at, number, gap_spins,
    prev_number, prev_color, prev_parity, window_index
  ) VALUES (NOW(), actual, gapSpins, prev, prevColor, prevParity, windowIndex)
}
```

### Behavior
- **Context Recording:** Stores what happened before the overdue number hit:
  - Previous number
  - Previous color
  - Previous parity
  - Window index

### Important Note
This only happens **if the gap is >= 40 spins**. If a number appears more frequently, it's not considered "overdue" and this learning doesn't happen.

### Impact
Future predictions use this context to pick overdue numbers more intelligently. The system learns which contexts lead to overdue numbers hitting.

---

## 6. Pattern Detection Updates

### How It Works
Pattern scores (A, B, C) are recalculated **on the next prediction**, not immediately after an outcome. This happens in `identifyActivePattern()` function (`src/services/prediction.engine.js` line 230-269).

### Behavior
- **Dynamic Pattern Selection:** Pattern scores update based on last 200 results (default, configurable via PRED_LOOKBACK)
- **Pattern A:** Based on sequential pairs rate (if seqRate >= 0.25, score += 1.0)
- **Pattern B:** Based on odd/even and small/big balance (if within 8% of 50%, score += 0.6 each)
- **Pattern C:** Based on gap statistics and unseen numbers (if 3+ unseen OR 10+ with high median gap, score += 1.2)

### Important Note
This doesn't happen immediately after an outcome - it happens when the **next prediction is made**. The pattern recalculation uses the latest data including the outcome that just happened.

### Impact
The system adapts to changing game patterns automatically. If the game starts showing more sequential patterns, Pattern A score increases and gets selected more often.

---

## 7. AI Cooldown Learning

### How It Works
AI predictions have stricter learning - too many wrong predictions trigger longer cooldowns. This is checked in `shouldTriggerAI()` function (`src/services/prediction.engine.js` lines 512-614).

**Process:**
```javascript
// Tracks consecutive wrong AI predictions
const { streak, lastTs } = await getAiConsecutiveWrongStreak(10);
if (streak >= 3) {
  // Check time since last wrong
  if (timeSinceLastWrong < 120 minutes) {
    // Block AI predictions
    return { trigger: false, reason: 'ai_consecutive_wrong_streak_cooldown' }
  }
}
```

### Behavior
- **3+ consecutive wrong AI predictions** → 120 minute cooldown (AI_STREAK_COOLDOWN_MIN)
- **Prevents over-reliance** on AI when it's not working
- **Resets** when AI gets a correct prediction (the streak breaks)

### Important Distinction
This is different from the pause mechanism:
- **Pause (10 minutes):** Happens when AI gets 3+ wrong in a row, blocks AI from making predictions
- **Cooldown (120 minutes):** Prevents AI from being triggered again for 120 minutes after the last wrong prediction

### Impact
The system avoids wasting resources on AI when it's performing poorly.

---

## Complete Learning Flow

### Scenario: Wrong Prediction

1. **Outcome Processed** (`processOutcomeForImage`):
   - Actual result: `22` (wasn't in top 5 or pool)
   - Prediction marked as `correct: false` in the database
   - `handleOutcome()` is called with the result

2. **Streak Updated** (`updateStreak`):
   - `wrong_streak` incremented (e.g., 1 → 2)
   - **If reaches 3:** Next prediction will **trigger AI** instead of local (checked in `shouldTriggerAI`)
   - ⚠️ **Local predictions continue regardless** - they are never paused or stopped
   - **If AI source and reaches 3:** Window paused for 10 minutes (AI blocked, local still works)

3. **Transitions Learned** (`handleOutcome` lines 478-510):
   - `number_transitions`: `prev → 22` count increased
   - `number_transitions_windowed`: Window-specific transition recorded
   - `window_number_followups`: Cross-window transition recorded (e.g., window 2 → window 3)

4. **Reactivation Feedback** (`handleOutcome` lines 512-537, **only if reactivation was used**):
   - Snapshot outcome recorded: `(snapshotId, false)`
   - Hit rate decreased via EMA
   - Future matches will prioritize other snapshots

5. **Overdue Learning** (`processOutcomeForImage` lines 112-156, **only if gap >= 40**):
   - If `22` was overdue (gap >= 40), context recorded:
     - Previous number, color, parity
     - Window index
   - Future overdue selections use this context

6. **Pattern Recalculation** (happens on **next prediction**, not immediately):
   - Next prediction calls `identifyActivePattern()`
   - Recalculates Pattern A/B/C scores using latest 200 results (including the outcome)
   - May switch to different pattern if conditions changed

---

## Key Learning Principles

1. **Wrong Predictions Still Teach:**
   - Actual results are always recorded
   - Transitions and patterns update regardless of prediction correctness

2. **Adaptive Strategy Switching:**
   - ⚠️ **Local predictions NEVER pause or stop** - they always continue
   - When `wrong_streak >= 3`, system escalates to AI (but local can still run)
   - AI predictions pause for 10 minutes after 3+ wrong
   - AI has a 120 minute cooldown after consecutive wrongs

3. **No Direct Weight Adjustment:**
   - ⚠️ Current system does NOT adjust scoring weights based on outcomes
   - Rule weight adjustment only exists in legacy `prediction_logs` system
   - Learning happens through data updates (transitions, reactivation hit rates)

4. **Context-Aware:**
   - Learning considers context (window, previous number, color, etc.)
   - Not just raw numbers, but situational patterns

5. **Exponential Moving Average:**
   - Recent outcomes have more weight than old ones
   - Hit rates adapt quickly to changing conditions (for reactivation snapshots)
   - Alpha = 0.2 means 20% weight to new outcome, 80% to old average

6. **Conditional Learning:**
   - Reactivation learning only happens if reactivation was used
   - Overdue learning only happens if gap >= 40 spins
   - Pattern recalculation happens on next prediction, not immediately

---

## What Doesn't Learn Directly

The system **does NOT** directly adjust:
- **Scoring weights** (W.gapPressure, W.streakBreak, etc.) - These are fixed or env-configurable
- **Pool size** (always 13 numbers)
- **Top 5 vs Pool 8** split (always 5+8)
- **Rule weights** - ⚠️ Not used in current system (only in legacy `prediction_logs`)

However, learning happens through:
- Pattern selection changes (Pattern A/B/C recalculation on next prediction)
- Transition data updates (affects pool building)
- Reactivation hit rates (affects snapshot matching priority)
- Strategy switching (local → AI when wrong_streak >= 3)