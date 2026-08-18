import { JobsWorkspace } from "../../components/jobs/JobsWorkspace";
import { RoutePage } from "../../components/shell/RoutePage";

export default function JobsPage() {
  return <RoutePage compact eyebrow="page.jobs.eyebrow" title="page.jobs.title" description="page.jobs.description"><JobsWorkspace /></RoutePage>;
}
