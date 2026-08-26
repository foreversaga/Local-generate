---
name: reference-pose-description
description: Convert an adult reference photo or fixed photo template into an unambiguous image-generation description using joint geometry, weight support, contact points, camera position, perspective, visibility, and crop. Use when a generated pose or composition must stay close to a reference; do not use to invent unseen identity or clothing details.
---

# Reference Pose Description

Translate what the body physically does instead of relying on a pose name such as “kneeling,” “crawling,” or “looking back.” A pose label may be included for readability, but it never replaces the constraints below.

## Build the description

Describe the reference in this order:

1. Establish the subject orientation relative to the camera and scene.
2. State the geometry of the shoulders, elbows, wrists, hips, knees, and ankles.
3. Name every weight-bearing support point and where each point contacts the surface.
4. State important non-contact relationships, especially parts that must stay separated.
5. Fix the camera side, height, distance, lens behavior, and perspective.
6. Define the frame edges with body parts that must be visible and body parts that must remain outside the crop.

Use measurable relative language when exact measurements are unavailable: “one forearm-length ahead of the shoulder line,” “at least shoulder-width apart,” “hips higher than knees,” or “camera at pelvis height.”

Pair the desired geometry with the most likely failure exclusion. For example: “hips fully lifted away from the heels; buttocks do not touch the heels or calves.” Do not use a negative phrase by itself.

Keep facial mood separate from body mechanics. “Face relaxed” must not become “body relaxed.” When the body actively bears weight, say so explicitly.

## Preserve the reference hierarchy

Treat these as hard constraints, in order:

1. Support points, joint geometry, and non-contact relationships.
2. Camera position, perspective, and crop.
3. Subject orientation and which surfaces are visible.
4. Clothing, face, and hairstyle variations.
5. Mood and minor photographic imperfections.

Changing clothes, face, or hair must not move the hands, knees, pelvis, torso, camera, or crop. Describe only surfaces visible from the fixed camera. Never rotate the body to reveal an unseen face or front-facing garment detail.

## Fit the H3 Studio prompt contract

Keep the normal eight prompt blocks. Put support, joints, contact, and non-contact constraints in `【動作與表情】`. Put camera, perspective, visible surfaces, and crop constraints in `【構圖與鏡位】`. Do not add an alternative pose or camera setup.

When a fixed template declares a highest-priority reference-pose constraint, preserve it verbatim or make it more explicit. Never summarize it back to a shorter pose label.

Read [references/pose-language.md](references/pose-language.md) when writing or auditing a fixed reference-photo template.

## Calibrate the claim

Text-only prompting improves adherence but does not provide exact geometric control. If near-pixel pose matching is required, recommend a pose, depth, edge, or reference-image conditioning path in addition to this description.
