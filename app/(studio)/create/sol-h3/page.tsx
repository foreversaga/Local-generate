import { RoutePage } from "../../../components/shell/RoutePage";
import { SolH3Workspace } from "../../../components/create/SolH3Workspace";

export default function SolH3Page() {
  return (
    <RoutePage
      eyebrowText="建立 / Sol-H3-Spark"
      titleText="Sol-H3 官方影片＋音訊"
      descriptionText="使用 NVIDIA Sana Sol-H3-Spark 的獨立兩階段 pipeline；固定輸出 1344×768、121 frames、24 FPS、MP4＋AAC。"
    >
      <SolH3Workspace />
    </RoutePage>
  );
}
