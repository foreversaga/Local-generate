import { RoutePage } from "../../../components/shell/RoutePage";
import { ImageToImageWorkspace } from "../../../components/tools/ImageToImageWorkspace";

export default function ImageToImagePage() {
  return (
    <RoutePage
      eyebrow="Tools / Image to Image"
      title="Image to Image"
      description="選擇來源圖片、設定提示詞與 ComfyUI checkpoint，提交可恢復的圖生圖工作並在此查看結果。"
    >
      <ImageToImageWorkspace />
    </RoutePage>
  );
}
