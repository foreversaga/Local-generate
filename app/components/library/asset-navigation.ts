import type { StudioAsset, StudioAssetFolder } from "./asset-client";

export type AssetFolderNode = {
    path: string[];
    count: number;
    roots: Set<StudioAsset["root"]>;
};

export function buildAssetNavigation(
    assets: StudioAsset[],
    currentPath: string[],
    folderRecords: StudioAssetFolder[] = [],
    kind?: StudioAsset["kind"],
) {
    const directAssets: StudioAsset[] = [];
    const folders = new Map<string, AssetFolderNode>();

    for (const asset of assets) {
        const segments = pathSegments(asset.name);
        if (!isPathWithin(segments, currentPath)) continue;
        const remainder = segments.slice(currentPath.length);
        if (remainder.length === 1) {
            directAssets.push(asset);
            continue;
        }
        if (remainder.length < 2) continue;
        addFolder(folders, [...currentPath, remainder[0]], 1, asset.root);
    }

    for (const folder of folderRecords) {
        const kindCount = kind === "image" ? folder.imageCount : kind === "video" ? folder.videoCount : folder.count;
        if (kind && kindCount === 0) continue;
        const segments = pathSegments(folder.path);
        if (!isPathWithin(segments, currentPath)) continue;
        const remainder = segments.slice(currentPath.length);
        if (!remainder.length) continue;
        addFolder(
            folders,
            [...currentPath, remainder[0]],
            folder.count,
            folder.root,
        );
    }

    return {
        directAssets: sortAssets(directAssets),
        folders: [...folders.values()].sort((left, right) => left.path.join("/").localeCompare(right.path.join("/"))),
    };
}

export function pathSegments(name: string) {
    return String(name || "").replaceAll("\\", "/").split("/").filter(Boolean);
}

export function isPathWithin(segments: string[], path: string[]) {
    return path.every((segment, index) => segments[index] === segment);
}

export function sortAssets(items: StudioAsset[]) {
    return [...items].sort((left, right) => String(right.modified).localeCompare(String(left.modified)));
}

function addFolder(
    folders: Map<string, AssetFolderNode>,
    path: string[],
    count: number,
    root: StudioAsset["root"],
) {
    const key = path.join("/");
    const folder = folders.get(key) ?? { path, count: 0, roots: new Set<StudioAsset["root"]>() };
    folder.count = Math.max(folder.count, count);
    folder.roots.add(root);
    folders.set(key, folder);
}
