import { RoutePage } from "../../../components/shell/RoutePage";
import { VideoCharacterWorkspace } from "../../../components/tools/VideoCharacterWorkspace";

export default function VideoCharacterPage() {
  return (
    <RoutePage
      eyebrowText="影片人物工作流程"
      titleText="場景換人物／DWPose 動作生成"
      descriptionText="保留原場景替換人物，或先從影片擷取 DWPose 動作骨架，再用參考圖片重新生成影片。"
    >
      <VideoCharacterWorkspace />
    </RoutePage>
  );
}
