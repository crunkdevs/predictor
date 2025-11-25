# Number Selection and Ranking Process

## Overview
This document explains how **13 numbers** are selected in the prediction system, how they are **scored**, and how **top 5** and **remaining 8** numbers are decided.

---

## Step 1: Building the Pool of 13 Numbers

The `buildNumberPool()` function selects **13 candidate numbers**. This process happens in **priority order**:

### Priority Order:

1. **Transitions (Highest Priority)**
   - Numbers that appeared after the last number
   - Historical transitions are checked from the database
   - Example: If the last number is `15`, then numbers that appeared after `15` are selected

2. **Reactivation (If Available)**
   - If a similar pattern was found in the past
   - Successful numbers from that pattern are added

3. **Pattern-Based Logic**
   - **Pattern A**: Focus on transitions (sequential thinking)
   - **Pattern B**: Balance logic - opposite parity/size from last number
     - Example: Last number `15` (odd, small) → select even or big numbers
   - **Pattern C**: Overdue numbers - numbers that haven't appeared for a long time

4. **Smart Overdue Selection**
   - Overdue numbers with historical context
   - Smart selection based on previous color

5. **Fallback**
   - If 13 numbers haven't been selected yet
   - Remaining valid numbers from 0-27 are added
   - (Orange/Red numbers are excluded)

**Result:** Exactly **13 candidate numbers** ready for scoring

---

## Step 2: Scoring Each Number

The `scoreAndRank()` function scores each number based on **multiple factors**.

### Scoring Formula:

```javascript
Final Score = 
  (0.22 × Gap Pressure) +           // How many spins since number appeared
  (0.18 × Streak Break) +           // Will it break color streak?
  (0.14 × Color Balance) +           // Color distribution balance
  (0.18 × Parity Rotation) +         // Odd/Even balance maintenance
  (0.18 × Size Regime) +            // Small/Big balance maintenance
  (0.10 × Reactivation Boost) +     // Past success match?
  (0.08 × Quad Parity) +            // 4-way balance (even_small, odd_big, etc)
  (0.06 × Trend Reversal)           // Trend change signal
```

### Score Factors Detail:

1. **Gap Pressure (22%)**
   - How long since the number appeared
   - Higher gap = higher score

2. **Streak Break (18%)**
   - If a color streak is active
   - Boost opposite color numbers

3. **Color Balance (14%)**
   - Recent color distribution
   - Boost underrepresented colors

4. **Parity Rotation (18%)**
   - Maintain Odd/Even balance
   - If too many odd appeared, boost even numbers

5. **Size Regime (18%)**
   - Maintain Small/Big balance
   - If too many small appeared, boost big numbers

6. **Reactivation Boost (10%)**
   - If past successful pattern matches
   - Give extra score to those numbers

7. **Quad Parity (8%)**
   - 4-way breakdown: even_small, even_big, odd_small, odd_big
   - Boost underrepresented category

8. **Trend Reversal (6%)**
   - Trend change signals
   - Boost reversal numbers

**Result:** Each number gets a **raw score**

---

## Step 3: Normalizing Scores

The `normalizeWeights()` function converts scores to **0-1 range**:

- **Min score** → 0
- **Max score** → 1
- **Other scores** → Between 0 and 1

**Example:**
- Raw scores: [0.5, 0.7, 0.9, 0.3, 0.6]
- Normalized: [0.33, 0.67, 1.0, 0.0, 0.5]

**Why?** So all factors have equal weight and comparison is easier.

---

## Step 4: Ranking (High to Low)

After scores are normalized, numbers are sorted in **descending order**:

```javascript
ranked.sort((a, b) => b.score - a.score);
```

**Result:** Number with highest score gets **Rank 1**, lowest score gets **Rank 13**

---

## Step 5: Deciding Top 5 and Remaining 8

In the final step, numbers are divided into two groups:

```javascript
const top5 = ranked.slice(0, 5);      // First 5 numbers (highest scores)
const pool = ranked.slice(5, 13);     // Next 8 numbers (lower scores)
```

### Breakdown:

- **Top 5 (Primary Predictions):**
  - Rank 1 (Highest score) → 1st position
  - Rank 2 → 2nd position
  - Rank 3 → 3rd position
  - Rank 4 → 4th position
  - Rank 5 → 5th position

- **Remaining 8 (Secondary Predictions):**
  - Rank 6 → 6th position
  - Rank 7 → 7th position
  - Rank 8 → 8th position
  - Rank 9 → 9th position
  - Rank 10 → 10th position
  - Rank 11 → 11th position
  - Rank 12 → 12th position
  - Rank 13 → 13th position

---

## Complete Example Flow

### Scenario:
- Last number: `15` (Dark Blue, Odd, Small)
- Pattern detected: `B` (Balance pattern)
- Recent colors: Pink (40%), Dark Blue (30%), Green (20%), Gray (10%)

### Step 1: Pool Building
1. Transitions from `15`: [8, 22, 11, 17, 4, 19]
2. Pattern B logic: Add Even or Big numbers
3. Color balance: Underrepresented colors (Sky Blue, Green)
4. **Result:** 13 numbers selected: [8, 22, 11, 17, 4, 19, 9, 18, 10, 16, 12, 14, 20]

### Step 2: Scoring
- Number `22`: 
  - Gap pressure: 0.8 (hasn't appeared for long time)
  - Color balance: 0.9 (Pink underrepresented)
  - Parity: 0.7 (Even balance)
  - **Total Score: 0.85**

- Number `8`:
  - Gap pressure: 0.6
  - Streak break: 0.5
  - **Total Score: 0.72**

- ... (other numbers)

### Step 3: Normalization
- Convert scores to 0-1 range

### Step 4: Ranking
- `22` → Rank 1 (score: 1.0)
- `11` → Rank 2 (score: 0.88)
- `17` → Rank 3 (score: 0.82)
- `8` → Rank 4 (score: 0.75)
- `19` → Rank 5 (score: 0.70)
- `4` → Rank 6 (score: 0.65)
- ... (others)

### Step 5: Final Division
- **Top 5:** [22, 11, 17, 8, 19]
- **Pool (Remaining 8):** [4, 9, 18, 10, 16, 12, 14, 20]

---

## Key Points

1. **13 Numbers Total:** Always exactly 13 numbers are selected
2. **Top 5 = Hot Numbers:** 5 numbers with highest scores (primary predictions)
3. **Remaining 8 = Cold Numbers:** 8 numbers with lower scores (secondary predictions)
4. **Ranking = Score Based:** Higher score = Higher rank
5. **Dynamic:** Scores and ranking change for each prediction
6. **Multiple Factors:** Not a single factor, multiple factors are combined
