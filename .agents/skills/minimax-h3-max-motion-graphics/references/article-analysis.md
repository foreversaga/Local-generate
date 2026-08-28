# Article analysis — How I write motion graphics prompts for MiniMax H3 Max

Source article: `https://x.com/i/article/2093131035156357120`

Original post: `https://x.com/ailker/status/2093165511920046289`

Author: Ilker (`@ailker`), Creative Engineer at fal.

Date: 2026-08-28.

The article was retrieved through Exa from the original X Article data, including its embedded markdown blocks, media references, and fal playground share links. This file records the reusable ideas without reproducing the article's full prompt library verbatim.

## 1. Why H3 Max changes the prompting strategy

The author says the key difference he noticed during evaluation was prompt adherence. Base MiniMax H3 is already capable at text-motion work, but the Max post-train is especially strong at understanding prompt instructions. That makes detailed temporal direction more worthwhile than on models that ignore fine sequencing.

Practical consequence for this project: spend prompt detail on **relationships and progression**, not generic quality adjectives.

## 2. Prompt Expansion policy

The article opens with prompt expansion because it changes how much responsibility the handwritten prompt carries.

The author's practical heuristic is:

- detailed and known to be H3-compatible -> disable expansion;
- detailed but compatibility is uncertain -> balanced expansion;
- very short request -> quality expansion can elaborate it;
- these choices are not strict laws.

Important implication: the skill should not blindly force `disabled`. It should first judge whether the prompt itself already speaks H3's language.

## 3. Production trick for text-heavy launch-video sections

The launch-video example is more important than it first appears because it is not purely a prompting trick; it is an iteration/editing strategy.

The process described in the article:

1. Generate roughly 10-15 T2V style variants.
2. Choose the strongest direction rather than trying to repair every take.
3. Improve selected key frames with an image model.
4. Build a first/last-frame segment from those cleaner states.
5. When the generated sequence starts to develop unwanted movement/text mixing late in the clip, cut the good section before the failure.
6. Create the next segment from another clean frame with a closer/more useful composition.
7. Join the two generated clips.
8. Because the second generated clip starts slowly and accelerates, remove part of that slow lead-in when inserting it into an edit that is already moving fast.

The article's concrete failure happened around the late part of a 15-second generation, reinforcing that **segment quality can be more useful than full-take purity**.

Skill implication: when exact logos, tables, or dense text are involved, recommend segmented first/last-frame repair instead of endlessly lengthening the prompt.

## 4. Timestamp prompting

The article demonstrates that H3 Max can follow a time schedule for text and visual state changes. Its sample sequence assigns short ranges to successive words/states and then transitions into a new framing state.

The author emphasizes that timestamps can specify:

- what text should be visible;
- what action should happen;
- what should be shown at a particular point.

He also explicitly advises against thinking this requires JSON or an extremely technical motion description. The preferred style is close to explaining a task to an LLM.

Skill implication: timecode is a **clarity tool**, not a machine-programming language.

## 5. Typography as complete layers

The text-animation section is one of the strongest reusable lessons.

The example defines four phrases as complete text layers before describing motion. The transitions are then created by moving the geometry around those text layers.

The article's embedded prompt rules establish these principles:

- transitions should originate from an existing text container, crop boundary, or baseline;
- each phrase should exist as one professionally typeset complete layer;
- individual letters should not be independently rebuilt, scrambled, morphed, regenerated, rotated, bent, or otherwise destabilized unless that is the explicit creative goal.

This is crucial for readability: animate **containers and masks**, not the spelling itself.

## 6. Readability versus motion blur

Another embedded rule separates motion blur from text readability:

- directional blur may be applied to moving slabs/masks;
- when a phrase is in its readable state, it should be sharp.

This is a better instruction than globally asking for motion blur or globally forbidding it.

Skill implication: blur should be scoped to the moving transition carrier, not the semantic text layer.

## 7. Text containers become transition geometry

The text example shows a sequence where a graphical edge changes roles over time: it can become a slab, crop window, baseline, then frame. The typography remains stable while the surrounding geometry evolves.

This leads to a general pattern:

```text
semantic layer stays stable
transition carrier changes role
new state is revealed through inherited geometry
```

That pattern is more important than the exact visual design of the original example.

## 8. Seamless transitions are not limited to typography

The next section generalizes the method to brand films and stylized sequences. The author argues that the same continuous flow can be applied across an entire 15-second sequence, and longer work can be built by generating multiple sequences and connecting them.

The common requirement is to make the transition source explicit.

## 9. Cowboy Bebop example — persistent circular trajectory

fal playground share:

`https://fal.ai/models/minimax/h3-max/text-to-video?share=26b78fc4-ddfe-4b7d-8b6b-0def1e4eface`

The article explains that several different objects/effects are connected because they share a circular trajectory. The prompt names the common shape and asks the main flow to continue through it.

Reusable pattern:

```text
choose a geometry
-> find that geometry in multiple scene elements
-> preserve trajectory/direction across each transformation
```

This is the clearest origin of the `motion spine` concept used by the skill.

## 10. Spirited Away example — style as the invariant

fal playground share:

`https://fal.ai/models/minimax/h3-max/text-to-video?share=c7f1c071-f3c0-4707-95a1-cf12288f0d39`

Here, the invariant is not one shape. The watercolor visual treatment is intended to survive across many transformations.

The embedded example describes a material-flow chain such as vapor/fog/reflection/ink/paper-like forms, while also assigning one camera behavior to each passage.

Reusable pattern:

- motion continuity can come from material/style rather than geometry;
- a passage should have one dominant transformation;
- camera behavior should be simple and distinct per passage.

## 11. Evangelion example — fixed continuity element and failure analysis

fal playground share:

`https://fal.ai/models/minimax/h3-max/text-to-video?share=2b118032-8a76-4d7b-9450-1e2a3b576a22`

The author's intent was to connect the full sequence with a cable. It did not remain successful through all middle passages.

His own diagnosis is valuable: he would strengthen the prompt by declaring the cable a fixed element that must always remain present, even if its visual treatment changes.

Reusable rule:

**If an element must persist, explicitly say it must remain present.**

Do not assume the model will infer persistent-object semantics from a single opening mention.

The embedded prompt also uses inheritance between passages: geometry or color should come from the previous clue rather than resetting.

## 12. Demon Slayer example — motion path alone is not enough

First version:

`https://fal.ai/models/minimax/h3-max/text-to-video?share=a5ab6fe4-8830-4a7e-b7f5-ebdb742c433c`

Style-locked version:

`https://fal.ai/models/minimax/h3-max/text-to-video?share=fa6b4d53-914a-49c1-8743-d1f908c006a4`

The core path is a diagonal brushstroke reused by different scene elements. In the first attempt, the author did not specify brush color/technique, so treatment varied between sections. The second prompt adds those properties and the model follows them much more closely.

Reusable rule:

**Lock both the path and the treatment when both matter.**

This is one of the article's clearest pieces of evidence that extra detail is valuable when it removes ambiguity rather than merely adding decoration.

## 13. Akira example — isolate the graphical anchor

The article's embedded rule identifies a red circle as the motion spine and describes an isolated red motorcycle tail-light-like element as a standalone graphical component.

Reusable insight:

When a real-world object is being used primarily as a motion-graphics shape, isolate the exact visual attribute that matters. This reduces the chance that irrelevant surrounding object geometry dominates the transformation.

## 14. Ghost in the Shell example — countable structure must remain distinct

One embedded rule uses a cyan cable-like line as the motion spine and explicitly requires four shadow/leg structures to remain separate and countable.

Reusable insight:

For structural/count constraints, write the count and the distinction requirement directly. If four branches/legs/shadows matter, say they are simultaneously visible and individually separable.

## 15. Princess Mononoke example — branching inheritance

The article's embedded rule uses a branching dark stroke and requires each clue to inherit some branch/split/track/fiber/liquid/reflection path from what is already visible.

Reusable insight:

The strongest seamless transitions are often not object-to-object descriptions; they are **path inheritance rules**.

This can be generalized to:

```text
previous path
-> transformed path
-> next scene structure
```

## 16. Howl's Moving Castle example — one line, many semantic roles

The article's embedded rule uses a wind-like line that successively becomes several environmental/object edges and material traces.

Reusable insight:

A motion spine can change semantic meaning while remaining visually continuous. The model does not need the object identity to remain constant if the trajectory/edge/material logic is carried forward clearly.

## 17. Dense clue sequences

Another embedded rule specifies an exact clue count grouped into passages, with one dominant transformation and one camera behavior per passage.

Reusable rule:

- group many clues into a small number of passages;
- do not give every clue an unrelated camera move;
- keep one dominant law within a passage.

This reduces motion chaos and improves the likelihood that the model respects the designed flow.

## 18. The author's final workflow assumption: use an LLM

Near the end, the author explicitly says the practical workflow is not manually authoring every long prompt from scratch. Users will reuse a strong prompt, send it to an LLM, and ask for the same logic with changed content.

That is exactly why this repository should contain a skill rather than just a static prompt library.

The skill's job is to preserve the motion logic while changing:

- theme;
- phrases;
- objects;
- palette;
- style;
- transformation chain.

## 19. What this article is not

This article is specifically about **motion-focused H3 Max prompting**, especially typography and seamless graphic transitions. It is not a general-purpose manual for:

- photoreal skin;
- actor blocking;
- complex dialogue;
- reference-to-video identity routing;
- local inference performance.

Those topics belong in other project guides/skills.

## 20. Practical summary for Local-generate

Use this article to add a motion-design layer to the existing H3 pipeline:

```text
user concept
-> LLM identifies exact text/assets
-> choose motion spine
-> split into timestamped passages
-> make every transition inherit from existing geometry/style/material
-> lock text readability and spine treatment
-> compile to local H3 prompt grammar if required
-> generate multiple variants
-> use first/last-frame segmentation when text-heavy sections drift
```

This is the intended scope of `$minimax-h3-max-motion-graphics`.
