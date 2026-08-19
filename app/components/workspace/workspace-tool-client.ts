import { adaptJob } from "../../lib/job-adapter.mjs";
import { buildWorkflowOpenPoseInput, resolveWorkflowUpscaleSource } from "../../lib/workflow-tool-input.mjs";
import type { UnifiedJob } from "../jobs/job-client";
import { submitImg2Img } from "../tools/img2img-client";
import { submitUpscale } from "../tools/upscale-client";
import type { WorkflowProject } from "./workflow-types";

export async function executeWorkflowOpenPoseNode(project: WorkflowProject, nodeId: string): Promise<UnifiedJob> {
    const input = buildWorkflowOpenPoseInput(project, nodeId);
    const job = await submitImg2Img(input);
    return adaptJob(job, "img2img") as UnifiedJob;
}

export async function executeWorkflowUpscaleNode(
    project: WorkflowProject,
    nodeId: string,
    jobs: UnifiedJob[],
): Promise<UnifiedJob> {
    const source = resolveWorkflowUpscaleSource(project, nodeId, jobs);
    if (!source) throw new Error("Upscale 節點需要上游已完成的影片工作，或一個影片素材。");
    const job = await submitUpscale(source);
    return adaptJob(job, "upscale") as UnifiedJob;
}
