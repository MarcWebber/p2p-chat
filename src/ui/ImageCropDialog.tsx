import { useEffect, useRef, useState, type PointerEvent } from "react";

const VIEWPORT_SIZE = 280;
const OUTPUT_SIZE = 200;

type Dimensions = { width: number; height: number };
type Position = { x: number; y: number };

type ImageCropDialogProps = {
  source: string;
  title: string;
  onCancel: () => void;
  onConfirm: (image: string) => void;
};

function imageLayout(dimensions: Dimensions | null, zoom: number) {
  if (!dimensions) return { width: VIEWPORT_SIZE, height: VIEWPORT_SIZE };
  const baseScale = Math.max(
    VIEWPORT_SIZE / dimensions.width,
    VIEWPORT_SIZE / dimensions.height,
  );
  return {
    width: dimensions.width * baseScale * zoom,
    height: dimensions.height * baseScale * zoom,
  };
}

function clampPosition(position: Position, dimensions: Dimensions | null, zoom: number) {
  const layout = imageLayout(dimensions, zoom);
  const maxX = Math.max(0, (layout.width - VIEWPORT_SIZE) / 2);
  const maxY = Math.max(0, (layout.height - VIEWPORT_SIZE) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, position.x)),
    y: Math.max(-maxY, Math.min(maxY, position.y)),
  };
}

export function ImageCropDialog({ source, title, onCancel, onConfirm }: ImageCropDialogProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; position: Position } | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setDimensions(null);
    setPosition({ x: 0, y: 0 });
    setZoom(1);
    setLoadFailed(false);
  }, [source]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  const layout = imageLayout(dimensions, zoom);

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dimensions) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      position,
    };
    setDragging(true);
  };

  const moveImage = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(clampPosition({
      x: drag.position.x + event.clientX - drag.x,
      y: drag.position.y + event.clientY - drag.y,
    }, dimensions, zoom));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const changeZoom = (nextZoom: number) => {
    setZoom(nextZoom);
    setPosition((current) => clampPosition(current, dimensions, nextZoom));
  };

  const confirm = () => {
    const image = imageRef.current;
    if (!image || !dimensions) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    const factor = OUTPUT_SIZE / VIEWPORT_SIZE;
    context.drawImage(
      image,
      (VIEWPORT_SIZE - layout.width) / 2 * factor + position.x * factor,
      (VIEWPORT_SIZE - layout.height) / 2 * factor + position.y * factor,
      layout.width * factor,
      layout.height * factor,
    );
    onConfirm(canvas.toDataURL("image/webp", 0.86));
  };

  return (
    <div className="dialog-backdrop crop-dialog-backdrop" role="presentation">
      <section className="image-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="crop-title">
        <div className="dialog-title-row">
          <div><strong id="crop-title">{title}</strong><small>拖动图片，使用滑杆放缩</small></div>
          <button type="button" onClick={onCancel} aria-label="关闭裁切">×</button>
        </div>
        <div
          className={`crop-viewport ${dragging ? "dragging" : ""}`}
          onPointerDown={beginDrag}
          onPointerMove={moveImage}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {!loadFailed ? (
            <img
              ref={imageRef}
              src={source}
              alt="待裁切图片"
              draggable={false}
              onLoad={(event) => setDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
              onError={() => setLoadFailed(true)}
              style={{
                width: layout.width,
                height: layout.height,
                left: (VIEWPORT_SIZE - layout.width) / 2 + position.x,
                top: (VIEWPORT_SIZE - layout.height) / 2 + position.y,
              }}
            />
          ) : <p>这个图片格式暂时无法读取，请换一张图片。</p>}
          <span className="crop-frame" aria-hidden />
        </div>
        <label className="crop-zoom">
          <span>缩小</span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.01"
            value={zoom}
            onChange={(event) => changeZoom(Number(event.target.value))}
            disabled={!dimensions}
            aria-label="缩放图片"
          />
          <span>放大</span>
        </label>
        <p className="crop-output-note">最终保存为 200 × 200 像素</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-dialog-button" onClick={onCancel}>取消</button>
          <button type="button" className="primary-dialog-button" onClick={confirm} disabled={!dimensions}>使用图片</button>
        </div>
      </section>
    </div>
  );
}
