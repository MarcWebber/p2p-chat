import { useState, type ChangeEvent } from "react";

import { CHAT_POLICY } from "@/src/config/policy";
import { AvatarContent, isImageAvatar } from "@/src/ui/AvatarContent";
import { ImageCropDialog } from "@/src/ui/ImageCropDialog";
import { ImageViewerDialog } from "@/src/ui/ImageViewerDialog";
import { readAsDataUrl } from "@/src/utils/browser";
import { formatBytes } from "@/src/utils/format";

type AvatarUploaderProps = {
  value: string;
  fallback: string;
  title: string;
  onChange: (value: string) => void;
};

export function AvatarUploader({ value, fallback, title, onChange }: AvatarUploaderProps) {
  const [cropSource, setCropSource] = useState("");
  const [notice, setNotice] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNotice("请选择图片文件。");
      return;
    }
    if (file.size > CHAT_POLICY.maxAvatarSourceBytes) {
      setNotice(`原图不能超过 ${formatBytes(CHAT_POLICY.maxAvatarSourceBytes)}。`);
      return;
    }
    try {
      setNotice("");
      setCropSource(await readAsDataUrl(file));
    } catch {
      setNotice("无法读取这张图片，请重试。");
    }
  };

  return (
    <div className="avatar-uploader">
      {isImageAvatar(value) ? (
        <button
          type="button"
          className="avatar-upload-preview avatar-preview-button"
          onClick={() => setPreviewOpen(true)}
          aria-label={`查看${title.replace(/^裁切/, "")}`}
          title="查看大图"
        >
          <AvatarContent value={value} fallback={fallback} alt={title} />
        </button>
      ) : (
        <span className="avatar-upload-preview">
          <AvatarContent value={value} fallback={fallback} alt={title} />
        </span>
      )}
      <div>
        <label className="avatar-upload-button">
          上传图片
          <input type="file" accept="image/*" onChange={chooseFile} />
        </label>
        {value !== fallback ? (
          <button type="button" className="avatar-reset-button" onClick={() => onChange(fallback)}>恢复默认</button>
        ) : null}
        <small>可移动、裁切和缩放</small>
      </div>
      {notice ? <p className="avatar-upload-notice">{notice}</p> : null}
      {cropSource ? (
        <ImageCropDialog
          source={cropSource}
          title={title}
          onCancel={() => setCropSource("")}
          onConfirm={(image) => {
            onChange(image);
            setCropSource("");
          }}
        />
      ) : null}
      {previewOpen && isImageAvatar(value) ? (
        <ImageViewerDialog
          source={value}
          title={title.replace(/^裁切/, "查看")}
          alt={title.replace(/^裁切/, "")}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}
