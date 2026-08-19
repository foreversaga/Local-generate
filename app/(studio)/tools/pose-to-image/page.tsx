import { RoutePage } from "../../../components/shell/RoutePage";
import { PoseToImageWorkspace } from "../../../components/tools/PoseToImageWorkspace";

export default function PoseToImagePage() {
    return (
        <RoutePage
            eyebrowText="工具 / OpenPose"
            titleText="OpenPose 骨架生圖"
            descriptionText="上傳人物圖片自動擷取 DWPose 骨架，輸入描述產生提示詞，再用 SDXL + ControlNet 依姿勢生成圖片。"
        >
            <PoseToImageWorkspace />
        </RoutePage>
    );
}
