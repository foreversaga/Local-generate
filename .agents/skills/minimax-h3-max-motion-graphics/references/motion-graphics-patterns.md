# Motion graphics patterns for MiniMax H3 Max

Use these patterns with `$minimax-h3-max-motion-graphics` after reading the article analysis.

The templates intentionally use natural language rather than JSON because the source article recommends prompting H3 Max more like an LLM/director than a low-level animation parser.

## Pattern A — kinetic typography with stable complete phrases

Use when exact text must remain clean while surrounding geometry creates motion.

```text
Create a [duration]-second [style] motion-graphics sequence.

TEXT LAYERS
T1: "[exact phrase 1]"
T2: "[exact phrase 2]"
T3: "[exact phrase 3]"
T4: "[exact phrase 4]"

TEXT RULE
Treat every phrase as one complete, professionally typeset, precomposed layer.
Do not construct or scramble individual letters.
Do not morph the spelling between phrases.
Keep text perfectly sharp whenever it is meant to be read.
Directional blur is allowed only on moving masks, slabs, crop windows, rails, or transition geometry.

MOTION SPINE
The transition source is always geometry already attached to the current text layer: its container edge, crop boundary, baseline, frame, or negative space.
No unrelated transition element appears from nowhere.

TIMELINE
0.0-[t1]s — [T1 state]. [Existing edge/container] begins moving and becomes [next transition carrier]. Camera: [one behavior].
[t1]-[t2]s — The same inherited geometry reveals T2 as a complete layer. [Transformation]. Camera: [one behavior].
[t2]-[t3]s — [Carrier] becomes [new carrier] without resetting the composition. T3 appears fully formed and readable. Camera: [one behavior].
[t3]-[end-hold]s — The inherited geometry resolves into the final frame/container and reveals T4.
[end-hold]-[end]s — Stop camera and layer movement. Hold the final phrase sharp and unchanged.

No additional readable text.
```

### Why this works

The semantic payload (the words) stays stable. Motion is delegated to geometry around it. This reduces spelling corruption while still allowing complex transitions.

## Pattern B — one motion spine across many visual clues

Use for anime-inspired sequences, title montages, brand films, or abstract clue chains.

```text
Create a [duration]-second continuous motion-design sequence with [N] visual clues grouped into [P] passages.

MOTION SPINE
The entire sequence is connected by one [shape/path/material] spine: [describe it].
Every new clue must inherit a visible path, contour, trajectory, color, material, or edge from the previous clue.
The spine may change semantic meaning, but its visual continuity must remain obvious.

PASSAGE 1 — [time]
Dominant transformation: [one law].
Clues: [A -> B -> C].
Camera: [one behavior].

PASSAGE 2 — [time]
Inherit [specific geometry/color/material] from Passage 1.
Dominant transformation: [one law].
Clues: [D -> E -> F].
Camera: [one behavior].

PASSAGE 3 — [time]
Inherit [specific property] from Passage 2.
Dominant transformation: [one law].
Clues: [G -> H -> I].
Camera: [one behavior].

STYLE LOCK
The spine always keeps [color / thickness / texture / material / brush technique].

FINAL STATE
Resolve the spine into [final object/frame/logo/shape], then hold for [0.5-2.0] seconds with no new motion.
```

## Pattern C — geometry-driven seamless transition

Use when a common shape appears across unrelated objects.

```text
The motion spine is one persistent [circle / diagonal / rectangle / curve / branch].

The sequence should never reset between scenes.
Instead, identify the same geometry in each state and carry the viewer through it:

[state A geometry]
-> becomes [state B geometry]
-> continues along the same [clockwise / diagonal / lateral] trajectory
-> becomes [state C geometry]
-> resolves into [final state].

Keep direction and travel sense consistent throughout.
The camera follows the same path rather than introducing an unrelated movement.
```

Good choices:

- record groove -> circular rim -> smoke curl -> orbit;
- tail light -> red circle -> sun/disc -> aperture;
- sword edge -> brushstroke -> water diagonal -> flame diagonal;
- rail -> baseline -> frame edge -> architectural line.

## Pattern D — material transformation spine

Use when continuity comes from material rather than geometry.

```text
The continuity rule is material transformation.
[material A] naturally becomes [material B],
then [B] becomes [C],
then [C] becomes [D].

Each transformation must visibly preserve some texture, flow direction, edge, or color from the previous state so it reads as one continuous material journey rather than unrelated scene cuts.
```

Examples of useful chains:

- steam -> fog -> water reflection -> ink -> paper silhouette;
- smoke -> cloud -> cloth fold -> painted brush haze;
- liquid trail -> cable -> blade edge -> contour line.

## Pattern E — style as the invariant

Use when no one shape persists but the artistic treatment must.

```text
STYLE CONTINUITY
The invariant across every passage is [watercolor / rough ink / cel animation / screen print / collage / charcoal].
Keep [paper texture, edge behavior, palette, line roughness, fill treatment] consistent across all transformations.

Objects and environments may change, but the visual material language never resets.
```

Do not say only `same style`. Name the actual properties that define the style.

## Pattern F — fixed continuity element

Use when one cable/line/logo/object must survive the entire clip.

```text
FIXED ELEMENT
[Element] is a fixed continuity anchor and must remain visibly present in every passage from start to finish.
It may change rendering style or physical interpretation only when explicitly described, but it must not disappear, be replaced by an unrelated element, or re-enter later after vanishing.

Every transition must originate from or reconnect to this fixed element.
```

Use this when a prior generation loses the intended anchor mid-sequence.

## Pattern G — style-lock repair

Use after a motion path works but its appearance drifts.

Weak:

```text
A diagonal brushstroke connects all scenes.
```

Stronger:

```text
A single diagonal brushstroke connects all scenes.
It is always [specific color], [specific opacity], with [dry-brush / wet-ink / calligraphic] texture and [specific edge quality].
Its angle and travel direction remain consistent from beginning to end.
```

Change only the style-lock portion first; do not rewrite the successful timeline.

## Pattern H — countable structural elements

Use when exact count matters.

```text
Keep exactly [N] [branches / legs / shadows / cables] visible at the same time.
They remain spatially separate and individually countable.
Do not merge, duplicate, hide, or fuse them during the transformation.
```

If the elements correspond to named positions, list them explicitly.

## Pattern I — first/last-frame repair for dense text

Use when a long T2V generation is strong early but text/logos corrupt late.

### Step 1 — explore

Generate several T2V variants using the same core prompt and choose the strongest style/motion direction.

### Step 2 — create clean anchors

Prepare clean images for:

- start state;
- important intermediate text/table/logo state;
- final state.

### Step 3 — generate segment A

Use first/last-frame generation between clean anchor 1 and anchor 2.
Stop using the segment before drift begins.

### Step 4 — generate segment B

Use anchor 2 (or a nearby corrected composition) and anchor 3.

### Step 5 — edit

If segment B begins with a slow acceleration but must join an already-fast sequence, trim its slow lead-in before the cut.

### Step 6 — verify

Check the join for:

- similar motion direction;
- compatible scale;
- matching color/style;
- no duplicate phrase;
- no slow-down bump at the edit.

## Pattern J — long video from multiple 15-second sequences

```text
SEQUENCE A
End with [explicit shape/path/style state]. Hold it cleanly.

SEQUENCE B
Begin from the same [shape/path/style state]. Start motion immediately in the same direction and inherit the same treatment.

JOIN RULE
The last visible transition carrier in A is the first transition carrier in B.
Do not begin B with a new establishing animation.
```

Use keyframes when the join must be exact.

## Pattern K — prompt expansion metadata

When returning a hosted fal H3 Max prompt, optionally add:

```text
Recommended prompt_expansion_mode: disabled
Reason: prompt already contains explicit timing, transition inheritance, exact text layers, and style locks.
```

or:

```text
Recommended prompt_expansion_mode: balanced
Reason: motion logic is detailed, but the prompt still benefits from H3-oriented normalization.
```

or:

```text
Recommended prompt_expansion_mode: quality
Reason: user supplied a short creative seed and expects the service to elaborate it.
```

Do not add this metadata when the local workflow has no corresponding setting.

## Pattern L — compile into local official H3 fields

If the local ComfyUI workflow expects MiniMax H3 base grammar:

```text
integrated_multimodal_description: [Shot 1] [global style + exact text-layer definitions + motion-spine rule]. [Timestamped transformation passages in chronological order]. [Readability/fixed-element/final-hold constraints].

overall_soundscape: [physical sounds and ambience, or N/A if intentional silence]

non_diegetic_music: [music description, or N/A]
```

The motion-graphics method belongs inside the visual timeline. Do not turn the entire prompt into JSON.

## Prompt review checklist

### Text

- Is every exact phrase declared once?
- Is spelling preserved?
- Is readable text protected from blur/morphing?

### Motion spine

- Is the persistent shape/path/material/style named?
- Does each transition inherit from something visible?
- Does the spine retain required treatment?

### Passage design

- Does each passage have one dominant transformation?
- Does each passage have one dominant camera behavior?
- Are there too many independent events for the available seconds?

### Continuity

- Are fixed elements explicitly required to remain present?
- Are exact structural counts protected?
- Does the final state hold cleanly?

### Production

- Would segmentation/keyframes be safer for dense logos/tables?
- Does a stitched second clip need its slow opening trimmed?
- Are settings appropriate for local H3 versus hosted H3 Max?
