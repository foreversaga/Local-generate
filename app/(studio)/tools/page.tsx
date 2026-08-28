"use client";

import { type ReactNode } from "react";
import { RouteCard, RouteGrid, RoutePage } from "../../components/shell/RoutePage";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./page.module.css";

export default function ToolsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh-TW";

  return (
    <RoutePage
      eyebrow="page.tools.eyebrow"
      title="page.tools.title"
      description="page.tools.description"
    >
      <ToolGroup
        eyebrow="CREATE"
        title={zh ? "建立圖片" : "Create images"}
        description={zh ? "從文字或姿勢開始建立新的視覺素材。" : "Create new visual assets from text or pose references."}
      >
        <RouteCard
          code="01 / TEXT TO IMAGE"
          title="tools.text2img.title"
          description="tools.text2img.description"
          href="/app/tools/text-to-image"
          actionLabel="action.openTool"
          headingLevel={3}
        />
        <RouteCard
          code="02 / POSE TO IMAGE"
          titleText={zh ? "OpenPose 骨架生圖" : "Pose to image"}
          descriptionText={zh
            ? "上傳人物圖片擷取 DWPose 骨架，再依描述與姿勢生成圖片。"
            : "Extract a DWPose skeleton from a character image, then generate a new image from the pose and description."}
          href="/app/tools/pose-to-image"
          actionLabel="action.openTool"
          headingLevel={3}
        />
      </ToolGroup>

      <ToolGroup
        eyebrow="EDIT"
        title={zh ? "編輯與增強" : "Edit & enhance"}
        description={zh ? "調整既有圖片、提升解析度，或延伸影片人物工作流程。" : "Transform existing images, improve resolution, or continue with video-character workflows."}
      >
        <RouteCard
          code="03 / IMAGE TO IMAGE"
          title="tools.img2img.title"
          description="tools.img2img.description"
          href="/app/tools/image-to-image"
          actionLabel="action.openTool"
          headingLevel={3}
        />
        <RouteCard
          code="04 / UPSCALE"
          title="tools.upscale.title"
          description="tools.upscale.description"
          href="/app/tools/upscale"
          actionLabel="action.openTool"
          headingLevel={3}
        />
        <RouteCard
          code="05 / VIDEO CHARACTER"
          titleText={zh ? "影片人物工作流程" : "Video character workflow"}
          descriptionText={zh
            ? "替換原影片人物，或以 DWPose 動作骨架搭配參考人物生成影片。"
            : "Replace a person in an existing video, or generate character video from DWPose motion and identity references."}
          href="/app/tools/video-character"
          actionLabel="action.openTool"
          headingLevel={3}
        />
      </ToolGroup>

      <ToolGroup
        eyebrow="TRAIN"
        title={zh ? "訓練" : "Train"}
        description={zh ? "建立可在生成流程重複使用的角色或風格能力。" : "Build reusable character or style capabilities for generation workflows."}
      >
        <RouteCard
          code="06 / LORA TRAINER"
          title="tools.lora.title"
          description="tools.lora.description"
          href="/app/tools/lora-trainer"
          actionLabel="action.openTool"
          headingLevel={3}
        />
      </ToolGroup>
    </RoutePage>
  );
}

function ToolGroup({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.group} aria-labelledby={`tool-group-${eyebrow.toLowerCase()}`}>
      <header className={styles.groupHeader}>
        <span className={styles.groupEyebrow}>{eyebrow}</span>
        <div>
          <h2 id={`tool-group-${eyebrow.toLowerCase()}`}>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <RouteGrid>{children}</RouteGrid>
    </section>
  );
}
