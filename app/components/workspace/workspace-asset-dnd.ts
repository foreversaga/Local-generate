import type { StudioAsset } from "../library/asset-client";

export const WORKSPACE_ASSET_DRAG_TYPE = "application/x-h3-studio-asset";

export function writeWorkspaceAssetDrag(event: DragEvent, asset: StudioAsset) {
    event.dataTransfer?.setData(WORKSPACE_ASSET_DRAG_TYPE, JSON.stringify(asset));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}

export function readWorkspaceAssetDrag(dataTransfer: DataTransfer): StudioAsset | null {
    try {
        const raw = dataTransfer.getData(WORKSPACE_ASSET_DRAG_TYPE);
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<StudioAsset>;
        if (!value.name || !value.root || !["image", "video"].includes(String(value.kind))) return null;
        return value as StudioAsset;
    } catch {
        return null;
    }
}
