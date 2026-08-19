export type WorkflowNode = {
    id: string;
    type: string;
    title: string;
    position: { x: number; y: number };
    status: string;
    config: Record<string, unknown>;
};

export type WorkflowEdge = {
    id: string;
    source: string;
    target: string;
};

export type WorkflowProjectAsset = {
    id: string;
    key: string;
    root: string;
    name: string;
    kind: "image" | "video";
    mime: string;
    size: number;
    modified: string;
    url: string;
    role: string;
    addedAt: string;
};

export type WorkflowProject = {
    version: number;
    id: string;
    name: string;
    brief: string;
    createdAt: string;
    updatedAt: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    assets: WorkflowProjectAsset[];
    checkpoints: unknown[];
};
