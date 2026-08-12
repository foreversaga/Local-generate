import { RouteCard, RouteGrid, RoutePage } from "../../components/shell/RoutePage";

export default function ToolsPage() {
  return (
    <RoutePage
      eyebrow="工具"
      title="工具"
      description="選擇要使用的本機工具；每個工作台都會在提交前顯示執行環境與模型狀態。"
    >
      <RouteGrid>
        <RouteCard
          code="01 / UPSCALE"
          title="影片升頻"
          description="使用 SeedVR2 3B Int8 將素材庫影片或上傳來源固定升頻 2×。"
          href="/app/tools/upscale"
          actionLabel="開啟工具"
        />
        <RouteCard
          code="02 / IMAGE TO IMAGE"
          title="以圖生圖"
          description="選取圖片、設定提示詞與模型設定檔，建立可追蹤的以圖生圖工作。"
          href="/app/tools/image-to-image"
          actionLabel="開啟工具"
        />
        <RouteCard
          code="03 / LORA TRAINER"
          title="LoRA 訓練"
          description="整理圖片與圖片描述，完成訓練前檢查後排入單 GPU 訓練佇列。"
          href="/app/tools/lora-trainer"
          actionLabel="開啟工具"
        />
      </RouteGrid>
    </RoutePage>
  );
}
