# How the Predictor Works

## What is this Predictor about?

This Predictor is an automated system that analyzes game results and makes predictions about future outcomes. It works with a number-based game where results range from 0 to 27. Each number has properties:

- **Color**: Red, Orange, Pink, Dark Blue, Sky Blue, Green, or Gray
- **Parity**: Even (0,2,4...) or Odd (1,3,5...)
- **Size**: Small (0-13) or Big (14-27)

## Complete System Flow

### 1. Image Ingestion and Processing

**How it works:**
- Game screenshots are captured and uploaded to the system
- Each image is stored with a unique ID to prevent duplicates
- The system extracts game information from the image:
  - The result number (0-27)
  - The three numbers shown on screen
  - Timestamp of when the result occurred

**What happens:**
1. Image is saved to the database
2. Image is parsed to extract game data
3. Statistics are stored
4. System checks if this image needs a prediction or if it should evaluate a previous prediction

### 2. Window Management System

**Window Structure:**
- Each day is divided into 12 time windows (typically 2 hours each)
- Windows cycle through indices 0-11, then repeat
- Each window has a delay period before predictions can start (to observe the game first)
  - Default delay: **20 minutes**
- Windows can be in different states: open, closed, paused, or observation mode
- Timezone used: **Asia/Shanghai**

**Window States:**
- **Open**: Window is active and accepting predictions
- **Closed**: Window has expired
- **Paused**: System has paused due to poor performance
- **Observe**: System is watching but not predicting (waiting for stability)

**Window Behavior:**
- System automatically creates windows for the current day
- Expired windows are automatically closed
- Each window tracks its own pattern state and prediction history
- Windows are independent - patterns and performance reset between windows

### 3. Pattern Detection - How It Actually Works

**Pattern Analysis Process:**

The system analyzes recent game results to identify which pattern is active:
- Lookback period: **120 results** (hardcoded in pattern detection)

**Pattern A Detection (Sequential/Pair Patterns):**
- Looks for sequential pairs (numbers that appear in order)
- Calculates the ratio of sequential pairs to total pairs
- If this ratio is **25% or higher**, Pattern A is likely
- Score: +1.0 if condition met

**Pattern B Detection (Balanced Distribution):**
- Analyzes the balance of even/odd and small/big numbers
- Checks if odd percentage is between **42-58%** (within 8% of 50%)
- Checks if small percentage is between **42-58%**
- Score: +0.6 for each balanced metric (max +1.2)

**Pattern C Detection (Overdue Numbers):**
- Counts how many numbers haven't appeared recently
- Counts how many numbers have high median gaps (**12 or more spins**)
- Score: +1.2 if **3 or more unseen numbers** OR **10 or more numbers** with high median gaps

**Pattern Selection:**
- All three patterns are scored
- The pattern with the highest score becomes active
- If scores are equal, Pattern A is the default

**Pattern Metrics Tracked:**
- Total spins analyzed
- Number of distinct colors used
- Average even ratio
- Average small ratio
- Maximum color run length

### 4. Number Pool Building - Step by Step

When making a prediction, the system builds a pool of candidate numbers:
- Pool size: **13 numbers** (hardcoded)

**Step 1: Transition-Based Selection**
- Looks at the last result number
- Queries historical data: "Which numbers most commonly follow this number?"
- Tries window-specific transitions first (if available)
- Falls back to global transitions if window data is insufficient
- Requires at least **2 occurrences** of a transition to be considered
- Adds top 12 transition candidates to the pool

**Step 2: Reactivation Numbers (if applicable)**
- If a similar past pattern is found (similarity of **75% or higher**)
- Adds numbers from that successful pattern's top pool
- Only activates if similarity is high enough

**Step 3: Pattern-Specific Logic**

**For Pattern B (Balanced Distribution):**
- If pool still needs numbers:
  - Looks at the last result
  - Calculates opposite parity (if last was even, wants odd)
  - Calculates opposite size (if last was small, wants big)
  - Adds numbers matching either opposite property

**For Pattern C (Overdue Numbers):**
- If pool still needs numbers:
  - Gets list of all numbers sorted by how long since last appearance
  - Adds numbers that haven't appeared recently
  - Prioritizes numbers with longest gaps

**Step 4: Smart Overdue Selection (NEW)**
- If pool still needs numbers:
  - Uses context-aware overdue selection instead of simple fallback
  - **How it works:**
    - System tracks when overdue numbers (gap >= 40 spins) actually hit
    - Remembers the context: what was the previous number's color when this overdue number hit?
    - When selecting overdue numbers, looks at historical patterns:
      - "When number X was overdue, did it hit more often after Red numbers or Blue numbers?"
    - Only picks overdue numbers that have a good historical track record in the current context
    - Requires sufficient historical data (at least 10 past occurrences) before trusting a pattern
    - Adds at most **1 smart overdue number** to the pool
  - **Why this is better:**
    - Old method: Just picked any overdue number (gap >= 50)
    - New method: Picks overdue numbers that historically hit in similar situations
    - Learns from past: "Number 15 tends to hit when overdue after Red numbers"

**Step 5: Complete Fill**
- If pool still has fewer than 13 numbers:
  - Simply fills remaining slots with any numbers 0-27 that aren't already in pool

**Result:** A pool of exactly 13 candidate numbers ready for scoring

### 5. Number Scoring and Ranking - Detailed Mechanics

Each number in the pool is scored using multiple weighted factors:

**Factor 1: Gap Pressure (22% weight)**
- Default weight: **0.22**
- Calculates how long since this number appeared
- Calculates the median gap for this number historically
- Numbers that haven't appeared in **30 or more spins** get maximum gap pressure
- Higher score means the number is more overdue

**Factor 2: Streak Break (18% weight)**
- Default weight: **0.18**
- Analyzes current color run (how many times same color appeared in a row)
- Determines if a streak break is likely:
  - If warm colors (Red/Orange/Pink) are running → predicts cool colors (Dark Blue/Sky Blue/Green)
  - If cool colors are running → predicts warm colors
  - If neutral (Gray) is running → predicts neutral
- Score: 1.0 if number matches predicted break color, 0.0 otherwise

**Factor 3: Color Balance (14% weight)**
- Default weight: **0.14**
- Analyzes color distribution in last **10 minutes**
- Calculates "color pressure" for each color
- Colors that appeared less frequently get higher pressure
- Score: The pressure value for this number's color (0.0 to 1.0)

**Factor 4: Parity Rotation (18% weight)**
- Default weight: **0.18**
- Analyzes even/odd balance in last **200 results**
- Calculates how close to 50/50 the distribution is
- Score: Higher when distribution is balanced (closer to 50/50)

**Factor 5: Size Regime (18% weight)**
- Default weight: **0.18**
- Analyzes small/big balance in last **200 results**
- Calculates how close to 50/50 the distribution is
- Score: Higher when distribution is balanced

**Factor 6: Reactivation Boost (10% weight)**
- Default weight: **0.10**
- Only applies if reactivation is active (similarity of **75% or higher**)
- If this number was in the successful past pattern's pool:
  - Calculates boost based on similarity (higher similarity = higher boost)
- Score: The boost value if number matches, 0.0 otherwise

**Factor 7: Quad Parity (8% weight)**
- Default weight: **0.08**
- Divides numbers into 4 quadrants:
  - Even-Small, Even-Big, Odd-Small, Odd-Big
- Analyzes distribution of these quadrants in last **200 results**
- Calculates which quadrants are underrepresented
- Score: Higher for numbers in underrepresented quadrants

**Factor 8: Trend Reversal (6% weight)**
- Default weight: **0.06**
- Only applies if trend reversal signal is detected
- Checks if number matches predicted reversal direction:
  - Color reversal: Warm→Cool or Cool→Warm
  - Size reversal: Small→Big or Big→Small
- Score: 1.0 if matches (60% weight for color, 40% for size), 0.0 otherwise

**Final Score Calculation:**
All factors are combined with their weights to create a total score for each number.

**Normalization:**
- All scores are normalized so the highest score becomes 1.0 and lowest becomes 0.0
- This ensures fair comparison regardless of absolute score values

**Ranking:**
- Numbers are sorted by score (highest first)
- Top **5** become "hot" numbers (primary predictions)
- Numbers **6-13** become "cold" numbers (secondary predictions)

### 6. Signal Detection - How It Works

**Deviation Signal Detection:**
- Compares short-term vs long-term color frequencies
- Short window: **30 minutes** (default parameter)
- Long window: **6 hours** (default parameter)
- Cache TTL: **60 seconds**
- Calculates the ratio for each color
- Detects deviation if:
  - Spread between ratios is **0.35 or higher**, OR
  - Mean ratio is **0.6 or lower** (underrepresented) OR **1.4 or higher** (overrepresented)
- Also detects reversal: any color with ratio of **1.3 or higher** (appearing much more frequently recently)

**Reversal Signal Detection:**
- Compares short-term vs long-term trends
- Short window: **10 minutes**
- Long window: **60 minutes**
- Delta threshold: **0.1** (10 percentage points)
- Cache TTL: **60 seconds**
- Analyzes color clusters:
  - Warm: Red, Orange, Pink
  - Cool: Dark Blue, Sky Blue, Green
  - Neutral: Gray
- Analyzes size: Small vs Big
- Detects reversal if:
  - Dominant color cluster changed between short and long term, AND
  - The change magnitude is **10 percentage points or more**
- Same logic for size reversals

**Reactivation Signal:**
- System stores "snapshots" of successful pattern states (**48-hour windows**)
- Each snapshot contains:
  - Pattern signature (color distribution, frequency patterns, etc.)
  - Top pool of numbers that were successful
  - Hit rate (how often those numbers appeared)
- When making predictions:
  - Current game state is converted to a signature
  - System searches for similar past snapshots
  - If similarity is **75% or higher**, reactivation is triggered
  - Numbers from that snapshot's successful pool are added to current pool

### 7. AI Prediction System - When and How

**AI Trigger Conditions:**

The system checks multiple conditions to decide if AI should be used:

1. **Window Status Check:**
   - Window must be open
   - Must be past the delay period after window starts
   - First predict delay: **20 minutes**

2. **Startup Delay:**
   - System must have been running for at least the startup delay period
   - Startup delay: **30 minutes**

3. **AI Streak Cooldown:**
   - If AI has been wrong the maximum wrong streak times in a row
   - Maximum wrong streak: **3**
   - Must wait cooldown period before using AI again
   - Cooldown: **120 minutes (2 hours)**

4. **Window Cap:**
   - Maximum AI predictions per window: **1**

5. **Daily Cap:**
   - Maximum AI predictions per day: **3**

6. **Time Gap:**
   - Minimum hours between AI predictions: **6 hours**

7. **Trigger Conditions (any of these):**
   - Deviation signal detected
   - Reversal signal detected
   - Wrong streak reaches the pause threshold (local predictions failing)
   - Pause after wrongs: **3**
   - Pattern is unknown or unclear

**AI Prediction Process:**

1. **Data Collection:**
   - Gathers recent results for analysis
   - Lookback: **200 results** (can be set to 'all')
   - Top K for hot/cold: **8**
   - Analyzes frequency distributions across multiple time windows
   - Calculates gap statistics (how long since each number appeared)
   - Analyzes color runs and patterns
   - Reviews recent prediction performance

2. **Baseline Prior Building:**
   - Creates initial probability distribution for all 28 numbers (0-27)
   - Uses weighted combination:
     - Last 20 results: **55% weight**
     - Last 100 results: **25% weight**
     - Last 200 results: **10% weight**
     - All-time totals: **10% weight**
   - Adjusts based on performance:
     - If accuracy is below **45%**: Increases weight on recent data, increases gap boost
     - If wrong streak is **3 or more**: Further increases recent data weight
     - If accuracy is above **58%** and correct streak is **3 or more**: Reduces gap boost (trusting patterns)

3. **Gap Boost Application:**
   - For each number, calculates how long since it appeared
   - Numbers that haven't appeared recently get higher probabilities

4. **Streak Break Hint:**
   - If color runs suggest a break is coming
   - Boosts probabilities for opposite color cluster

5. **Color Reweighting:**
   - If volatility is high or performance is poor
   - Adjusts probabilities to balance color distribution
   - Colors that appeared less get boosted

6. **AI Analysis:**
   - Sends all data to AI model
   - Model: **'gpt-5-mini'** (default in analyzer.ai.service.js) or **'gpt-4.1-mini'** (default in analyzer.service.js)
   - Temperature: **0.3** for GPT-5, **0.7** for GPT-4, or **0** for GPT-5 auto
   - AI receives:
     - Baseline probability distribution
     - Analytics bundle (gaps, ratios, patterns, time buckets)
     - Latest result and digit patterns
     - Recent prediction performance
   - AI outputs:
     - Odds multipliers for each number (**0.55 to 1.7 range**)
     - Pattern detection results
     - Rationale for adjustments

7. **Final Distribution:**
   - Combines baseline prior with AI multipliers
   - Applies smoothing adjustments
   - Penalizes recently predicted numbers (to avoid repetition)
   - Penalizes recently actual results (to avoid immediate repeats)
   - If distribution is too concentrated (entropy < 2.0 or top probability > 38%), applies additional smoothing to spread probabilities

8. **Top Selection:**
   - Selects number with highest probability
   - Extracts top **8** candidates with their probabilities
   - Stores as prediction

**AI Limits and Safeguards:**
- Daily cap of **3 predictions** prevents overuse
- Cooldown periods prevent repeated failures: **120 minutes**
- Minimum time gaps ensure data freshness: **6 hours**
- Window caps prevent window-specific overuse: **1 per window**
- Minimum seconds between predictions: **40 seconds**

### 8. Prediction Decision Flow

**Complete Decision Process:**

1. **Scheduler Triggers**
   - V2 Scheduler: Runs every **1 minute**
   - V1 Scheduler: Runs every **10 seconds**
   - Checks for new images that need predictions
   - Ensures windows are maintained

2. **Image Check:**
   - Finds images with stats but no prediction yet
   - Selects oldest unprocessed image for current window

3. **Window Lock:**
   - Locks the window row (prevents concurrent predictions)
   - Lock key (V2): **42843**
   - Analyze lock key: **972115**
   - Checks if AI is currently active (if yes, blocks local predictions)

4. **Permission Check:**
   - Checks if prediction is allowed:
     - Window must be open
     - Must be past the delay time (for AI)
     - Must not be paused
     - Must not be in observe mode (unless exiting)

5. **Pattern Detection:**
   - Analyzes last **120 results**
   - Calculates Pattern A, B, C scores
   - Sets active pattern to highest scoring one

6. **Reactivation Check:**
   - Generates current game state signature
   - Searches for similar past snapshots
   - If match found (similarity of **75% or higher**), activates reactivation

7. **Signal Detection:**
   - Checks for frequency deviations
   - Checks for trend reversals
   - Checks for historical reversal bias (window-specific patterns)

8. **AI Decision:**
   - Evaluates all AI trigger conditions
   - If triggered and allowed:
     - Generates AI prediction
     - If AI fails, falls back to local prediction
   - If not triggered:
     - Uses local prediction

9. **Local Prediction (if used):**
   - Gets last result number
   - Builds number pool (**13 candidates**)
   - Scores and ranks all candidates
   - Selects top **5** as hot, **6-13** as cold

10. **Prediction Storage:**
    - Stores prediction with:
      - Top 5 hot numbers
      - Cold numbers (6-13)
      - Pattern used
      - Source (local or AI)
      - All context (signals, trends, reactivation)
    - Marks prediction time in window state

11. **Analytics Push:**
    - Sends prediction data to connected clients
    - Updates real-time analytics

### 9. Outcome Evaluation - How Predictions Are Judged

**When Outcome is Processed:**

When a new game result arrives:
1. System finds the image stats for that result
2. Looks up the window this result belongs to
3. Finds the most recent prediction for that window (created before this result)
4. Checks if prediction has already been evaluated

**Correctness Calculation:**

A prediction is considered **correct** if:
- The actual result number appears in the **top 5 hot numbers**, OR
- The actual result number appears in the **cold numbers pool** (ranks 6-13)

**Evaluation Process:**

1. **Find Prediction:**
   - Queries predictions for the window
   - Gets prediction created before the result timestamp
   - Gets the prediction data (contains top5 and pool arrays)

2. **Extract Numbers:**
   - Gets top 5 array
   - Gets pool array (numbers 6-13)
   - Validates all numbers are 0-27

3. **Check Match:**
   - Checks if actual result is in hot numbers
   - Checks if actual result is in cold numbers
   - Marks as correct if match found, incorrect otherwise

4. **Update Prediction:**
   - Marks prediction as correct or incorrect
   - Records which image was used for evaluation
   - Updates timestamp

5. **Update Learning:**
   - Updates streak counters (correct_streak or wrong_streak)
   - Records number transitions (from previous result to actual)
   - Updates window-specific transitions
   - Updates window-to-window transitions
   - If reactivation was used, records outcome for that snapshot

### 10. Learning and Adaptation Mechanisms

**Streak Tracking:**

- **Correct Streak:** Counts consecutive correct predictions
  - Increments on correct prediction
  - Resets to 0 on wrong prediction

- **Wrong Streak:** Counts consecutive wrong predictions
  - Increments on wrong prediction
  - Resets to 0 on correct prediction
  - When wrong streak reaches the pause threshold:
    - Pause threshold: **3**
    - System pauses predictions for pause duration
    - Pause duration: **10 minutes**
    - Enters "paused" mode
    - After pause, enters "observe" mode until stability returns

**Transition Learning:**

- **Global Transitions:**
  - Records: "Number X was followed by Number Y"
  - Counts how many times each transition occurred
  - Used to build transition probabilities

- **Window-Specific Transitions:**
  - Same as global, but tracked per window index (0-11)
  - Captures patterns like "Window 3 often has transitions from 15→22"

- **Window-to-Window Transitions:**
  - Tracks: "In Window X, number Y appeared, then in next window, number Z appeared"
  - Captures cross-window patterns

**Pattern State Learning:**

- **Snapshot Storage:**
  - Every **48 hours**, system stores a "pattern snapshot"
  - Only if no recent snapshot exists (within **47 hours**)
  - Snapshot contains:
    - Color distribution signature
    - Frequency patterns
    - Successful number pool
    - Hit rate statistics
  - Used for future reactivation matching

- **Snapshot Matching:**
  - Current game state is converted to a signature
  - System searches for similar past snapshots
  - Similarity calculated using pattern matching algorithms
  - If similarity is **75% or higher**, reactivation triggers

- **Snapshot Outcome Tracking:**
  - When reactivation is used, outcome is recorded
  - Hit rate is updated using exponential moving average
  - Successful snapshots get higher priority in future matches

**Adaptive Behavior:**

- **Performance-Based Adjustments:**
  - If accuracy is below **45%**: System increases focus on recent data, gap pressure
  - If wrong streak is **3 or more**: System pauses and observes
  - If accuracy is above **58%** with correct streak: System trusts patterns more, reduces gap boost

- **Pattern-Specific Adaptations:**
  - Pattern A: Focuses on sequential transitions
  - Pattern B: Emphasizes balance (opposite parity/size)
  - Pattern C: Prioritizes overdue numbers

- **Window-Specific Learning:**
  - Each window index (0-11) learns its own patterns
  - Transitions are tracked per window
  - Historical reversal bias is calculated per window

**Observation Mode:**

- **When Entered:**
  - After pause period expires
  - When game is unstable (long color runs, limited color variety)

- **Stability Check:**
  - Analyzes recent results for stability
  - Lookback: **30 results**
  - Maximum run allowed: **3**
  - Minimum colors required: **5**
  - Checks: Maximum color run ≤ max_run AND distinct colors used ≥ min_colors
  - If stable: Exits observe mode, resumes predictions
  - If unstable: Continues observing

### 11. System Maintenance and Background Tasks

**Scheduled Tasks:**

The system runs scheduled tasks to:

1. **Window Maintenance:**
   - Ensures windows exist for current day
   - Closes expired windows
   - Creates new windows as needed

2. **Pattern Snapshot Storage:**
   - Every **48 hours**, stores current pattern state
   - Only if no recent snapshot exists (within **47 hours**)
   - Captures successful patterns for reactivation

3. **Analytics Refresh:**
   - Refreshes statistical views:
     - Color runs statistics
     - Hourly accuracy breakdown
     - Accuracy breakdown by pattern/source

4. **Rule Weights Maintenance:**
   - Updates statistical rule weights
   - Maintains pattern detection accuracy

5. **Prediction Generation:**
   - Main prediction logic (as described above)

**Data Flow:**

- **Incoming:** Game images → Image stats → Predictions
- **Outgoing:** Predictions → Outcome evaluation → Learning updates
- **Analytics:** Real-time updates to connected clients

### 12. Key Behavioral Details

**Why 13 Numbers in Pool?**
- Pool size is **13 numbers** total (hardcoded)
- Top **5** are "hot" (primary predictions)
- Numbers **6-13** are "cold" (secondary predictions)
- Total of 13 gives good coverage while maintaining focus

**Why Multiple Scoring Factors?**
- No single factor is perfect
- Combining multiple signals reduces false positives
- Weighted combination allows system to adapt to different game states

**Why Pattern-Based Pool Building?**
- Different game states require different strategies
- Pattern A: Trust transitions (sequential thinking)
- Pattern B: Trust balance (distribution thinking)
- Pattern C: Trust gaps (overdue thinking)

**Why AI Has Limits?**
- AI is expensive and slower
- Local predictions are usually sufficient
- AI reserved for difficult situations
- Limits prevent over-reliance on AI

**Why Observation Mode?**
- Game can be unstable (long streaks, limited variety)
- Making predictions during instability is unreliable
- Better to wait for stability than make bad predictions

**Why Window System?**
- Game patterns may vary by time of day
- Windows allow pattern learning per time period
- Each day has **12 windows** (indices 0-11)
- Prevents one bad period from affecting entire day
- Allows system to learn "Window 3 usually has pattern X"
- Timezone: **Asia/Shanghai**

**Why Reactivation?**
- Past successful patterns may repeat
- If current state matches past success, reuse that strategy
- Adds memory and learning to the system

## Complete Example Flow

**Scenario: New game result arrives**

1. **Image Processing:**
   - Image uploaded → Stored → Parsed
   - Result: 15 (Dark Blue, Odd, Small)
   - Stats inserted into database

2. **Outcome Evaluation (if prediction exists):**
   - Finds previous prediction for this window
   - Checks if 15 is in top 5 or pool
   - Marks prediction correct/incorrect
   - Updates streaks and transitions

3. **Pattern Update:**
   - Analyzes last **120 results** including new result
   - Recalculates Pattern A/B/C scores
   - Updates active pattern if changed

4. **New Prediction (if conditions allow):**
   - Checks window status (open? past delay?)
   - Checks if paused or observing
   - Detects pattern (e.g., Pattern B)
   - Checks for signals (deviation? reversal?)
   - Checks for reactivation match
   - Decides: Local or AI?
   - If Local:
     - Gets last result (15)
     - Builds pool: transitions from 15, pattern-B logic, overdue numbers
     - Scores all **13 candidates**
     - Ranks: Top **5** = hot, **6-13** = cold
   - Stores prediction
   - Pushes to analytics

5. **Learning:**
   - Records transition: previous → 15
   - Updates window-specific transition
   - Updates window-to-window transition
   - If reactivation used, records outcome

**Result:** System has made a new prediction and learned from the outcome, ready for the next cycle.

## Smart Overdue Logic - How It Works

### The Concept

Instead of blindly picking any overdue number, the system now learns from history: "When overdue numbers hit, what was the situation like?" It remembers the context (like what color came before) and uses that to make smarter selections.

### The Learning Process

**1. Tracking Overdue Hits:**
- When a number hits after being overdue (gap >= 40 spins), the system remembers:
  - Which number hit
  - How overdue it was
  - What the previous number was (especially its color)
  - When it happened (which time window)

**2. Pattern Recognition:**
- Over time, the system builds patterns like:
  - "Number 15 tends to hit when overdue, especially after Red numbers"
  - "Number 22 rarely hits when overdue after Blue numbers"
- These patterns are stored and used for future predictions

### The Selection Process

When the pool needs more numbers:

1. **Find Overdue Candidates:**
   - Looks for numbers that haven't appeared in 40+ spins
   - Needs at least 6 such numbers before considering smart selection

2. **Check Historical Patterns:**
   - For each overdue number, asks: "Has this number hit when overdue in similar situations before?"
   - Compares current context (last number's color) with historical patterns
   - Calculates success rate: "Out of all times this number was overdue, how often did it hit with this color context?"

3. **Filter and Rank:**
   - Only considers numbers with:
     - At least 10 historical occurrences (enough data to trust)
     - At least 40% success rate in this context (proven pattern)
   - Ranks by: success rate first, then how overdue (larger gap = higher priority)

4. **Select:**
   - Picks the best candidate (if any meet the criteria)
   - Adds at most 1 smart overdue number to the pool

### Why This Is Better

**Old Method:**
- Simple rule: "If gap >= 50, add it"
- No learning, no context
- Could pick numbers that historically don't work in current situation

**New Method:**
- Learns from past: "This number works in this context"
- Context-aware: Matches current situation with historical patterns
- Conservative: Only acts when there's enough evidence
- Improves over time: More data = better patterns

### Example

**Scenario:**
- Last number: 5 (Red)
- Number 15 is overdue (hasn't appeared in 45 spins)
- Number 20 is overdue (hasn't appeared in 52 spins)

**Old Method:**
- Would pick 20 (larger gap) or both

**New Method:**
- Checks history: "When 15 was overdue, did it hit more after Red numbers?"
- Checks history: "When 20 was overdue, did it hit more after Red numbers?"
- If 15 has 60% success rate after Red (with 15+ samples) and 20 has 30% success rate after Red
- Picks 15 (better historical match for current context)
