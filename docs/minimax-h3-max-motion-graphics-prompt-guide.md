# MiniMax H3 Max Motion Graphics Prompt Guide

Source: Ilker, **How I write motion graphics prompts for MiniMax H3 Max**

- Original X post: https://x.com/ailker/status/2093165511920046289
- X Article: https://x.com/i/article/2093131035156357120
- Author: `@ailker`, Creative Engineer at fal
- Published: 2026-08-28

This guide was rebuilt after retrieving the original X Article through Exa and reading the full article, including embedded markdown examples and fal playground links.

This document is deliberately scoped to **motion graphics prompting**. It is not a replacement for the existing realistic-video prompt guide.

## 1. Main conclusion

The article's core lesson is not "write a huge prompt." It is:

> Make every motion state inherit a visible rule from the previous state, then tell H3 Max when that handoff happens.

The reusable structure is:

```text
exact content
+ motion spine
+ timestamped passages
+ inherited transitions
+ one camera behavior per passage
+ style/readability locks
+ final hold
```

For text-heavy work, add a production strategy around first/last-frame keyframes and segment stitching rather than insisting that one 15-second raw generation stay perfect from start to finish.

## 2. Prompt Expansion

The source article recommends choosing prompt expansion based on how complete and H3-native the prompt already is.

| Prompt condition | H3 Max setting |
| --- | --- |
| Detailed and known to be H3-compatible | `disabled` |
| Detailed but uncertain H3 wording | `balanced` |
| Very short creative request | `quality` |

This is guidance, not a strict rule.

The local H3 workflow should not receive this setting unless the active node/API supports an equivalent option.

## 3. Prompt H3 Max like an LLM, not a motion-programming parser

The author explicitly says complex H3 Max motion work does not require JSON or microscopic animation instructions.

Good prompt language describes relationships:

```text
The edge of the current text tile continues downward and becomes the baseline of the next phrase.
```

Less useful for this model:

```text
{"object":"edge","x":312,"y":102,"duration":0.33,"easing":"cubic-bezier(...)"}
```

Use timestamps for sequence clarity, but keep the prose understandable as a creative instruction.

## 4. Timestamps

Use time ranges when multiple visual states must appear in order.

Example pattern:

```text
0.0-2.0s — first readable state
2.0-4.5s — current geometry transforms into the next reveal mechanism
4.5-7.0s — second state appears
7.0-9.0s — inherited geometry continues into the next scene
9.0-10.0s — final hold
```

Each range should identify:

1. what is currently visible;
2. what existing element triggers the transition;
3. what it becomes;
4. what new state is revealed;
5. what the camera does.

## 5. Text animation: treat each phrase as one complete layer

The article's text-animation example is especially useful for keeping H3 Max text readable.

Declare exact phrases before the timeline:

```text
T1: "ONE IDEA."
T2: "ONE MOVE."
T3: "CLEAR RESULT."
T4: "BUILD THE LINK."
```

Then animate the objects around those phrases.

Recommended rules:

- each phrase is one complete typeset layer;
- spelling does not regenerate during motion;
- containers, masks, baselines, crop windows and frames can move;
- individual letters should remain untouched unless deliberate glyph animation is the goal;
- no extra readable text should appear.

## 6. Blur must not destroy readability

The source example separates motion blur from text blur:

```text
moving slab/mask -> directional blur allowed
readable phrase -> sharp / zero blur
```

This scope-specific instruction is more reliable than globally enabling or disabling motion blur.

## 7. Motion spine

A **motion spine** is the visual rule that survives between scenes.

It can be:

- a circle;
- cable;
- brushstroke;
- smoke path;
- branch;
- contour;
- crop edge;
- baseline;
- reflected line;
- color;
- material;
- watercolor/ink visual treatment.

The object itself does not need to remain semantically identical. What needs to remain continuous is the visual logic.

## 8. Inherited transitions

The strongest pattern across the article's examples is inheritance.

Instead of:

```text
Scene A ends. Cool transition. Scene B starts.
```

write:

```text
The line already visible in Scene A continues across frame, thickens into the edge of Scene B's object, and the camera follows that same path into the next composition.
```

Useful inherited properties:

- line/path;
- direction;
- color;
- shape;
- material;
- pattern;
- silhouette;
- reflection;
- crop boundary;
- negative space.

## 9. Example lessons from the article

### Cowboy Bebop — common circular geometry

The sequence is linked by several elements that share circular motion/shape. The important lesson is not the anime theme; it is to explicitly name the shared geometry and trajectory so different objects feel like one continuous motion.

Playground: https://fal.ai/models/minimax/h3-max/text-to-video?share=26b78fc4-ddfe-4b7d-8b6b-0def1e4eface

### Spirited Away — style/material continuity

Here the invariant is the watercolor-like treatment rather than one fixed shape. The transformation chain passes through related material states while each passage uses a simple camera behavior.

Playground: https://fal.ai/models/minimax/h3-max/text-to-video?share=c7f1c071-f3c0-4707-95a1-cf12288f0d39

### Evangelion — fixed element must be stated explicitly

The intended cable did not survive all middle sections. The author specifically notes that a better prompt would declare the cable fixed and always present even when its style changes.

Playground: https://fal.ai/models/minimax/h3-max/text-to-video?share=2b118032-8a76-4d7b-9450-1e2a3b576a22

### Demon Slayer — lock treatment as well as trajectory

The first prompt defined a diagonal brush path but not its color/technique, so different sections rendered it differently. The revised version adds style properties and improves consistency.

First version: https://fal.ai/models/minimax/h3-max/text-to-video?share=a5ab6fe4-8830-4a7e-b7f5-ebdb742c433c

Style-locked version: https://fal.ai/models/minimax/h3-max/text-to-video?share=fa6b4d53-914a-49c1-8743-d1f908c006a4

### Akira — isolate only the graphical property that matters

A red circular object is treated as an isolated graphic anchor rather than asking the model to preserve all surrounding object context.

Lesson: if an object exists mainly to provide a shape/color/motion cue, describe that cue explicitly.

### Ghost in the Shell — exact count and separation

The embedded prompt requires four structures to remain separately visible and countable while a cyan cable-like line acts as the motion spine.

Lesson: numeric structural constraints must state both **count** and **separation**.

### Princess Mononoke — branching path inheritance

Each clue inherits a branch/track/fiber/liquid/reflection path from what was already present.

Lesson: continuity can be defined as a path family rather than object identity.

### Howl's Moving Castle — same line, different meanings

A single line can successively become environmental and object edges while maintaining visual continuity.

Lesson: semantic identity can change completely if path/edge continuity remains clear.

## 10. One dominant law per passage

For dense sequences, group many clues into a few passages.

Recommended default for a 15-second sequence:

- 3-5 passages;
- one dominant transformation law per passage;
- one dominant camera behavior per passage;
- inherit geometry/color/material between passages.

Do not make every clue use a different camera move and transition logic.

## 11. First/last-frame repair for dense text and logos

The launch-video section describes a practical editing workflow:

```text
T2V variants
-> select best style
-> create/enhance clean keyframes
-> generate first/last-frame segment
-> cut before text/motion drift
-> generate next segment from a corrected keyframe
-> trim slow startup if required
-> join
```

This is particularly useful for:

- benchmark tables;
- multiple logos;
- dense brand copy;
- text that stays correct early but breaks late.

H3 Max speed makes this selection-heavy workflow reasonable.

## 12. Why trimming the next segment can matter

The author notes that generated video commonly begins with slower motion and accelerates. When segment B is inserted into an edit where segment A is already moving quickly, the slow lead-in creates an obvious pacing bump.

Practical fix:

```text
trim part of B's slow opening
or
regenerate B with an already-active starting state
```

Do not automatically trim every clip; use this only when the join visibly decelerates.

## 13. Long-form motion graphics

To exceed one 15-second sequence:

```text
Sequence A ends on a clean transition carrier.
Sequence B begins from the same carrier/state.
Use first/last-frame anchors if exact continuity matters.
Keep direction, palette and spine treatment compatible across the join.
```

The first visible moment of the new sequence should not feel like a new establishing animation if it is supposed to continue the existing motion.

## 14. Local H3 integration

The source article targets fal H3 Max, but the creative logic is usable with local MiniMax H3.

When the local workflow expects H3's official base prompt grammar:

```text
integrated_multimodal_description: [style + exact text declarations + motion spine + timestamped passages + transition/readability constraints]

overall_soundscape: [ambient/physical sound]

non_diegetic_music: [score or N/A]
```

Keep the official keyframe alignment line for image/first-last-frame modes if the current workflow requires it.

Do not copy hosted-only fields into local nodes without checking support.

## 15. Recommended skill

Project skill:

```text
.agents/skills/minimax-h3-max-motion-graphics/SKILL.md
```

Detailed source analysis:

```text
.agents/skills/minimax-h3-max-motion-graphics/references/article-analysis.md
```

Reusable templates:

```text
.agents/skills/minimax-h3-max-motion-graphics/references/motion-graphics-patterns.md
```

Example use:

```text
$minimax-h3-max-motion-graphics
Create a 15-second motion-graphics prompt around four exact phrases.
Use one continuous red-circle motion spine, keep every phrase readable,
and make each transition inherit geometry from the previous state.
```

## 16. Skill acceptance checklist

A prompt produced with this method should answer yes to the following:

- Are exact phrases declared before motion?
- Is there one identifiable motion spine or style invariant?
- Does every transition originate from something already visible?
- Are timestamps used only where order matters?
- Is each dense passage governed by one main transform and camera behavior?
- Are fixed elements explicitly required to remain present?
- If brush/line/material appearance matters, is the treatment locked?
- Is blur restricted away from readable text?
- Does the final visual state hold cleanly?
- Would first/last-frame segmentation be safer than one raw take for dense copy/logos?
- Are local H3 and hosted H3 Max settings kept separate?
