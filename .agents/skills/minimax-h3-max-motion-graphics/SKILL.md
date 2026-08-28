---
name: minimax-h3-max-motion-graphics
description: Write MiniMax H3 Max motion-graphics prompts using the prompting method from Ilker's Aug 28, 2026 guide: prompt-expansion selection, timestamps, complete text layers, seamless inherited transitions, motion spines, style locks, fixed continuity elements, first/last-frame repair, and multi-clip stitching. Use for kinetic typography, title sequences, anime-inspired motion studies, brand motion, text-heavy videos, or any H3/H3 Max request where transitions must flow from one visible element into the next.
compatibility: Project-local Agent Skill for Local-generate. The creative method targets H3 Max but can be compiled to the local MiniMax H3 prompt format. Do not assume fal H3 Max runtime options exist locally; runtime/model changes require an explicit user request.
---

# MiniMax H3 Max Motion Graphics

## Source

This skill is based on Ilker's original X Article, **How I write motion graphics prompts for MiniMax H3 Max**:

`https://x.com/i/article/2093131035156357120`

The article was retrieved and read in full, including its embedded examples and outbound fal playground references. Read `references/article-analysis.md` for the section-by-section analysis and `references/motion-graphics-patterns.md` for reusable patterns.

## Core idea

H3 Max is unusually strong at following motion instructions. Use that strength to describe **what should happen over time and how one visible state becomes the next**, rather than writing a dense technical simulation or JSON storyboard.

The most reusable mental model is:

```text
concept
-> declared text/assets
-> motion spine / persistent visual rule
-> timestamped passages
-> inherited transitions
-> camera behavior per passage
-> readability/style locks
-> final hold
```

The prompt should read like a clear instruction to a capable LLM/director, not like machine-readable animation code.

## 1. Decide Prompt Expansion before writing

When the active endpoint exposes H3 Max prompt expansion, choose it deliberately:

- `disabled`: the prompt is already detailed, H3-compatible, and its wording/timing should remain intact.
- `balanced`: the prompt is detailed but may not fully match H3's preferred wording; let the service normalize it lightly.
- `quality`: the user supplied only a short idea and wants the service to elaborate it.

These are heuristics, not hard rules. A detailed prompt can still use quality expansion if the user prefers it.

For the local H3 workflow, ignore this setting if no equivalent runtime control exists.

## 2. Do not default to JSON

Do not convert a motion-graphics request into JSON unless the receiving API explicitly requires JSON fields around the prompt.

Inside the actual prompt:

- prefer natural-language instructions;
- use short named sections when they improve clarity;
- use timestamps for ordering;
- describe the visual relationship between states;
- avoid excessive numeric micro-animation unless exact timing truly matters.

If prompt expansion is disabled, ensure the final wording is compatible with MiniMax H3/H3 Max before returning it.

## 3. Define exact text as complete layers

For text-heavy motion graphics, declare all required phrases up front and preserve them as complete precomposed layers.

Example structure:

```text
TEXT LAYERS
T1: "FIRST PHRASE"
T2: "SECOND PHRASE"
T3: "THIRD PHRASE"
```

Unless the user explicitly wants per-letter animation:

- do not build words letter by letter;
- do not scramble or regenerate letters during transitions;
- do not morph individual glyphs into unrelated glyphs;
- keep typography stable while containers, masks, crop windows, rails, shapes, or camera position create the transition.

Exact text must be copied literally from the user request.

## 4. Use timestamps to control sequence order

For anything beyond one beat, write a timeline.

Prefer ranges such as:

```text
0.0-2.0s — establish phrase / object
2.0-5.0s — transform existing element into the next container
5.0-8.0s — reveal the next state
8.0-10.0s — settle and hold
```

Each passage should answer:

- what is already visible;
- what existing element starts the transition;
- what it becomes;
- what new state is revealed;
- what the camera does during that passage.

Do not use timestamps merely for decoration. Timing must fit the requested duration.

## 5. Choose a motion spine

A **motion spine** is the persistent visual logic that carries the viewer from one passage to the next.

It can be:

- a geometric shape, such as a circle;
- a line/path, such as smoke, cable, brushstroke, contour, reflection, rail, or branch;
- a material behavior, such as ink, paper, water, steam, or smoke;
- a stable visual style, such as watercolor treatment;
- a text-derived geometry, such as a crop edge, baseline, word mask, or negative space inside a letter.

Write the spine explicitly. The next scene should inherit something already visible instead of introducing an unrelated transition device from nowhere.

## 6. Make every transition inherit from the previous state

For seamless motion, preserve at least one visible property across each handoff:

- line;
- trajectory;
- geometry;
- color;
- material;
- pattern;
- silhouette;
- crop edge;
- text container;
- negative space;
- camera direction.

A strong transition describes a transformation chain:

```text
existing element A becomes B;
B continues as C;
C reveals D without resetting the composition.
```

Avoid repeated hard resets unless the intended edit calls for them.

## 7. Group complex sequences into passages

For dense 15-second motion studies, group clues/scenes into a small number of passages.

A practical default is 3-5 passages. Within each passage:

- choose one dominant transformation law;
- choose one dominant camera behavior;
- inherit geometry/color/material from the previous passage;
- keep the visual idea simple enough to execute cleanly.

If the user specifies an exact clue count or shot count, respect it.

## 8. Lock the style of the spine when it matters

If the same motion spine must preserve a particular treatment, specify that treatment explicitly.

Examples of useful locks:

- brush color and brush texture;
- line thickness and roughness;
- watercolor paper texture;
- cable color/material;
- smoke density and direction;
- graphic palette;
- flat/vector versus photographic rendering.

Do not assume that naming the path alone will preserve its appearance. If the treatment changes accidentally, strengthen the style lock rather than rewriting the entire prompt.

## 9. Mark fixed elements as fixed

If an element must remain present throughout the sequence, say so directly.

Use statements such as:

```text
The cable is a fixed continuity element and must remain visible in every passage, although its rendering style may change.
```

or:

```text
The red circle is the persistent anchor for the entire sequence; every scene must contain or inherit it.
```

Do not rely on implication. The original article specifically highlights failure caused by a continuity element disappearing mid-sequence.

## 10. Typography readability rules

For readable text:

- moving masks/slabs may use directional motion blur;
- text itself should be sharp when the phrase is meant to be read;
- give each phrase enough hold time;
- preserve spelling and phrase order;
- keep typography treatment consistent unless a deliberate style change is specified;
- end with a stable hold when the final message matters.

Avoid unnecessary glyph animation when the goal is clean text.

## 11. Camera behavior supports the motion spine

Do not use many unrelated camera moves in the same passage.

Useful passage-level behaviors include:

- quiet push;
- low lateral track;
- left-to-right follow;
- fast pullback;
- locked frontal hold;
- movement through letter negative space;
- movement along a line/path already on screen.

The camera should reinforce the transition logic rather than compete with it.

## 12. Text-heavy repair with first/last frames

When text or logos begin to corrupt late in a long generation, do not force one perfect take.

Use an edit-oriented workflow:

1. Generate multiple T2V variants to explore the look.
2. Select the cleanest visual direction.
3. Extract or recreate clean keyframes for important text/table/logo states.
4. Use first/last-frame generation to build the segment between clean states.
5. Cut the segment before visible drift begins.
6. Start the next segment from a clean keyframe that matches the desired handoff.
7. Join the strongest sections.

If the second generated segment begins with the common slow motion ramp and must enter an already-fast edit, trim the slow lead-in before joining.

This is a production technique, not a requirement for every prompt.

## 13. Generate many, select, and combine

H3 Max's speed makes search-and-select practical. For difficult text/logo motion:

- generate several candidates;
- keep the cleanest motion/text region from each;
- combine compatible segments;
- do not treat one raw generation as sacred.

When the user asks for a fully automated pipeline, preserve prompt/settings metadata for every candidate so chosen segments remain traceable.

## 14. Local MiniMax H3 compatibility

This skill defines motion logic. The local project may still expect MiniMax H3's official prompt grammar.

When the local workflow expects the official base fields, compile the motion plan into:

```text
integrated_multimodal_description: ...

overall_soundscape: ...

non_diegetic_music: ...
```

Put timestamped motion/text transitions inside `integrated_multimodal_description` and keep audio fields separate.

For first/last-frame modes, preserve the project's required keyframe alignment instruction.

Do not add hosted fal settings such as `prompt_expansion_mode` to a local ComfyUI node unless that node actually supports them.

## 15. Iteration strategy

Change the smallest responsible rule:

- wrong text -> strengthen complete-layer/readability rules;
- text blurs while readable -> restrict blur to moving masks/containers;
- transition feels disconnected -> strengthen inheritance from the prior visible element;
- motion spine disappears -> declare it fixed and always present;
- style changes halfway -> lock spine color/material/technique;
- sequence feels chaotic -> reduce each passage to one transformation and one camera behavior;
- late-stage corruption -> split the sequence and use keyframe stitching;
- first seconds of a stitched segment feel too slow -> trim the lead-in or regenerate with a faster opening state.

Do not rewrite every part after one failure.

## 16. Final QA

Before returning the prompt, verify:

- all exact phrases are spelled correctly;
- required text is declared as complete layers;
- timeline fits the requested duration;
- every transition starts from something already visible;
- the motion spine is named and remains coherent;
- fixed elements are explicitly protected;
- each passage has a clear transformation and camera behavior;
- style locks cover color/material/technique when continuity depends on them;
- text is sharp during readable holds;
- the final state has enough hold time;
- local/hosted runtime settings are not mixed accidentally.

## Output rules

When the user asks for a copy-paste prompt:

- output the finished prompt first;
- keep it natural language, not JSON, unless the API wrapper is also requested;
- include a short settings block only when the requested runtime supports those settings;
- preserve exact visible text in the requested language;
- do not add unrelated cinematography detail that does not serve the motion concept.
