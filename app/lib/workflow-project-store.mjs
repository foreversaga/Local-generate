import { isWorkflowProject } from "./workflow-project.mjs";

export const WORKFLOW_PROJECTS_STORAGE_KEY = "h3-studio.workflow-projects.v1";

export function listWorkflowProjects(storage) {
    return readProjects(storage).sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
}

export function getWorkflowProject(storage, projectId) {
    const id = String(projectId || "").trim();
    if (!id) return null;
    return readProjects(storage).find((project) => project.id === id) || null;
}

export function saveWorkflowProject(storage, project) {
    assertStorage(storage);
    if (!isWorkflowProject(project)) throw new TypeError("Invalid workflow project.");

    const projects = readProjects(storage);
    const index = projects.findIndex((item) => item.id === project.id);
    const nextProjects = index >= 0
        ? projects.map((item, itemIndex) => itemIndex === index ? project : item)
        : [project, ...projects];
    storage.setItem(WORKFLOW_PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    return project;
}

export function deleteWorkflowProject(storage, projectId) {
    assertStorage(storage);
    const id = String(projectId || "").trim();
    if (!id) return false;
    const projects = readProjects(storage);
    const nextProjects = projects.filter((project) => project.id !== id);
    if (projects.length === nextProjects.length) return false;
    storage.setItem(WORKFLOW_PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    return true;
}

function readProjects(storage) {
    assertStorage(storage);
    try {
        const parsed = JSON.parse(storage.getItem(WORKFLOW_PROJECTS_STORAGE_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter(isWorkflowProject) : [];
    } catch {
        return [];
    }
}

function assertStorage(storage) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
        throw new TypeError("Workflow project storage must implement getItem and setItem.");
    }
}

function timestamp(value) {
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
}
