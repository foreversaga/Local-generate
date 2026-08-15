import { CreateLanding } from "../../components/create/CreateLanding";
import { RoutePage } from "../../components/shell/RoutePage";

export default function CreatePage() {
    return (
        <RoutePage
            eyebrow="page.create.eyebrow"
            title="page.create.title"
            description="page.create.description"
        >
            <CreateLanding />
        </RoutePage>
    );
}
