import { JobsWorkspace } from "../../components/jobs/JobsWorkspace";
import { RoutePage } from "../../components/shell/RoutePage";

export default function JobsPage() {
  return <RoutePage eyebrow="Jobs" title="生成工作" description="Single、Long、Upscale 與 Image to Image 的工作歷史集中管理，使用同一套五狀態 UI。"><JobsWorkspace /></RoutePage>;
}
