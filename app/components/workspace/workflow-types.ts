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

export type WorkflowProject = {
    version: number;
    id: string;
    name: string;
    brief: string;
    createdAt: string;
    updatedAt: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    assets: unknown[];
    checkpoints: unknown[];
};
