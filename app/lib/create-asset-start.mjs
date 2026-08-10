import {
    createSingleCreateDraft,
    parseSingleCreateDraft,
} from "./single-create-draft.mjs";

export function draftForCreateAsset(serializedDraft, asset) {
    const current = parseSingleCreateDraft(serializedDraft) || createSingleCreateDraft({});
    const key = `${asset.root}:${asset.name}`;

    if (asset.kind === "image") {
        return createSingleCreateDraft({
            ...current,
            mode: "i2v",
            referenceImageKey: key,
            referenceImageKeys: [],
            lastFrameImageKey: null,
            sourceVideoKey: null,
        });
    }

    return createSingleCreateDraft({
        ...current,
        mode: "ref2v",
        modelProfile: "ref2va_pruned_nvfp4",
        referenceImageKey: null,
        referenceImageKeys: [],
        lastFrameImageKey: null,
        sourceVideoKey: key,
    });
}
