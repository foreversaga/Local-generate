import { ProjectWorkspace } from "../../../../components/workspace/ProjectWorkspace";

type Props = { params: Promise<{ projectId: string }> };

export default async function ProjectWorkspacePage({ params }: Props) {
    const { projectId } = await params;
    return <ProjectWorkspace projectId={projectId} />;
}
