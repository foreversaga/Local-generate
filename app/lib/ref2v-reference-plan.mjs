export const MAX_REF2V_IMAGES = 9;

export const REF2V_WORKFLOW = "character_motion";
export const REF2V_REFERENCE_ROLES = Object.freeze(["character", "face", "clothing"]);
export const REF2V_CLOTHING_MODES = Object.freeze(["character", "reference", "description"]);

function normalizedArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizedClothingMode(value) {
  return REF2V_CLOTHING_MODES.includes(value) ? value : "character";
}

/**
 * Build the only supported UI order for the character-motion Ref2VA workflow.
 * The returned roles array stays index-aligned with references.
 * @template T
 * @param {{characterImages?: T[], faceImages?: T[], clothingMode?: string, clothingImages?: T[]}} input
 * @returns {{references: T[], roles: string[], clothingMode: string}}
 */
export function buildRef2VOrderedReferences({
  characterImages = [],
  faceImages = [],
  clothingMode = "character",
  clothingImages = [],
} = /** @type {any} */ ({})) {
  const mode = normalizedClothingMode(clothingMode);
  const groups = [
    { role: "character", values: normalizedArray(characterImages) },
    { role: "face", values: normalizedArray(faceImages) },
    { role: "clothing", values: mode === "reference" ? normalizedArray(clothingImages) : [] },
  ];
  const references = [];
  const roles = [];
  for (const group of groups) {
    for (const value of group.values) {
      if (references.length >= MAX_REF2V_IMAGES) break;
      references.push(value);
      roles.push(group.role);
    }
  }
  return { references, roles, clothingMode: mode };
}

/**
 * Validate an aligned role list received by the bridge. Legacy generic Ref2VA
 * requests omit the workflow and continue treating every picture generically.
 */
export function normalizeRef2VReferencePlan({
  workflow,
  referenceImageNames = [],
  referenceImageRoles,
  clothingMode,
  clothingDescription,
} = {}) {
  const names = normalizedArray(referenceImageNames).slice(0, MAX_REF2V_IMAGES);
  if (workflow !== REF2V_WORKFLOW) {
    return {
      workflow: "generic",
      roles: names.map(() => "reference"),
      clothingMode: "character",
      clothingDescription: "",
    };
  }
  if (!Array.isArray(referenceImageRoles) || referenceImageRoles.length !== names.length) {
    throw Object.assign(new TypeError("referenceImageRoles must match referenceImageNames."), { code: "REFERENCE_IMAGE_ROLES_MISMATCH" });
  }
  const roles = referenceImageRoles.map((value, index) => {
    if (!REF2V_REFERENCE_ROLES.includes(value)) {
      throw Object.assign(new TypeError(`referenceImageRoles[${index}] is invalid.`), { code: "REFERENCE_IMAGE_ROLE_INVALID" });
    }
    return value;
  });
  const order = roles.map((role) => REF2V_REFERENCE_ROLES.indexOf(role));
  if (order.some((value, index) => index > 0 && value < order[index - 1])) {
    throw Object.assign(new TypeError("Ref2VA pictures must be ordered as character, face, then clothing references."), { code: "REFERENCE_IMAGE_ROLE_ORDER_INVALID" });
  }
  if (!roles.includes("character")) {
    throw Object.assign(new TypeError("At least one character reference image is required."), { code: "CHARACTER_REFERENCE_REQUIRED" });
  }
  const mode = normalizedClothingMode(clothingMode);
  const description = typeof clothingDescription === "string" ? clothingDescription.trim().slice(0, 2000) : "";
  if (mode === "reference" && !roles.includes("clothing")) {
    throw Object.assign(new TypeError("Clothing reference mode requires at least one clothing image."), { code: "CLOTHING_REFERENCE_REQUIRED" });
  }
  if (mode !== "reference" && roles.includes("clothing")) {
    throw Object.assign(new TypeError("Clothing pictures are only valid in clothing reference mode."), { code: "CLOTHING_REFERENCE_MODE_INVALID" });
  }
  if (mode === "description" && !description) {
    throw Object.assign(new TypeError("Clothing description mode requires a description."), { code: "CLOTHING_DESCRIPTION_REQUIRED" });
  }
  return { workflow: REF2V_WORKFLOW, roles, clothingMode: mode, clothingDescription: description };
}

function labelsForRole(roles, target) {
  return roles.flatMap((role, index) => role === target ? [`<Picture ${index + 1}>`] : []);
}

function joinedLabels(labels) {
  if (labels.length <= 1) return labels[0] || "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** Compile deterministic role constraints for the H3 prompt-writing model. */
export function buildRef2VCharacterMotionContext(plan, { sourceVideoName = "" } = {}) {
  if (plan?.workflow !== REF2V_WORKFLOW) return "";
  const characters = labelsForRole(plan.roles, "character");
  const faces = labelsForRole(plan.roles, "face");
  const clothing = labelsForRole(plan.roles, "clothing");
  const lines = [
    "Ref2VA character-motion replacement workflow. The following picture roles are authoritative and must stay aligned with their exact Picture numbers in all six output sections.",
    `${joinedLabels(characters)} ${characters.length === 1 ? "is" : "are"} the character-identity reference ${characters.length === 1 ? "image" : "images"}. Use them for the same adult character's identity, face, hairstyle, skin appearance, body proportions, height-to-body ratio, shoulder width, waist and hip proportions, and limb proportions. <Picture 1> is the primary reference; later character pictures reinforce the same identity from additional views.`,
  ];
  if (faces.length) {
    lines.push(`${joinedLabels(faces)} ${faces.length === 1 ? "is an additional high-detail facial reference" : "are additional high-detail facial references"} for that same character. Transfer only facial identity details; do not take clothing, body proportions, pose, background, or another person's identity from these pictures.`);
  }
  if (plan.clothingMode === "character") {
    lines.push("Clothing source: preserve the clothing visible in <Picture 1> throughout the entire target video. Other pictures must not override that outfit.");
  } else if (plan.clothingMode === "reference") {
    lines.push(`${joinedLabels(clothing)} ${clothing.length === 1 ? "is a clothing-only reference image" : "are clothing-only reference images"}. Transfer only the garments, colors, materials, construction, fit, footwear, and accessories to the target character; never transfer the pictured person's identity, face, hair, skin, body shape, pose, or background.`);
  } else {
    lines.push(`Clothing source: replace the clothing visible in all pictures with this user-authored clothing specification, translated into precise English and integrated into <Subject 1> and every applicable shot: ${plan.clothingDescription}`);
  }
  lines.push(
    `<Video 1> is the supplied motion and whole-video structural reference${sourceVideoName ? ` (asset: ${sourceVideoName})` : ""}. Use it strictly for choreography, performance timing, body movement, footwork, hand movement, pose transitions, limb trajectories, foot placement, turns, acceleration, rhythm, camera composition, camera movement, environment, lighting, and scene layout.`,
    "Transfer the original performer's choreography to the target character, but completely remove the original performer's identity, face, hairstyle, body shape, proportions, skin appearance, and clothing.",
    "Use [reference generation] unless another explicitly supplied relationship requires a different legal task prefix. Define the target character as <Subject 1>, define the preserved environment as a separate subject, and define the choreography from <Video 1> as a separate subject with attribute_transfer to <Subject 1>.",
    "Maintain one consistent target identity, body shape, and outfit across every frame. Integrate any user-authored description into the relevant subject definitions, retention analysis, and shot descriptions instead of appending it as detached prose.",
  );
  return lines.join("\n");
}
