import { JobDetailWorkspace } from "../../../components/jobs/JobDetailWorkspace";
import { RoutePage } from "../../../components/shell/RoutePage";

type Props={params:Promise<{id:string}>;searchParams:Promise<{source?:string}>};
export default async function JobDetailPage({params,searchParams}:Props){const {id}=await params;const {source}=await searchParams;return <RoutePage eyebrow="Jobs / Detail" title={`Job ${id}`} description="查看階段、進度、ETA、輸出與既有 backend 支援的工作動作。"><JobDetailWorkspace jobId={id} sourceHint={source}/></RoutePage>}
