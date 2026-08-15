import { JobDetailWorkspace } from "../../../components/jobs/JobDetailWorkspace";
import { RoutePage } from "../../../components/shell/RoutePage";

type Props={params:Promise<{id:string}>;searchParams:Promise<{source?:string}>};
export default async function JobDetailPage({params,searchParams}:Props){const {id}=await params;const {source}=await searchParams;return <RoutePage eyebrow="page.jobDetail.eyebrow" title="page.jobDetail.title" titleVariables={{id}} description="page.jobDetail.description"><JobDetailWorkspace jobId={id} sourceHint={source}/></RoutePage>}
