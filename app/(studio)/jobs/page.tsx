import { JobsWorkspace } from "../../components/jobs/JobsWorkspace";
import { RoutePage } from "../../components/shell/RoutePage";

export default function JobsPage() {
  return <RoutePage eyebrow="工作" title="生成工作" description="單次影片、長影片、升頻與以圖生圖的工作歷史集中管理，使用一致的工作狀態。"><JobsWorkspace /></RoutePage>;
}
