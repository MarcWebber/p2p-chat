import { useEffect, useRef, useState } from "react";

type ImageViewerDialogProps = {
  source: string;
  title: string;
  alt: string;
  onClose: () => void;
};

export function ImageViewerDialog({ source, title, alt, onClose }: ImageViewerDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!dialog) return;
    dialog.showModal();
    closeButtonRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => setLoadFailed(false), [source]);

  return (
    <dialog
      ref={dialogRef}
      className="image-viewer-dialog"
      aria-labelledby="image-viewer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="image-viewer-card">
        <header>
          <strong id="image-viewer-title">{title}</strong>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭图片预览">×</button>
        </header>
        <div className="image-viewer-canvas">
          {loadFailed
            ? <p role="status">这张图片暂时无法显示。</p>
            : <img src={source} alt={alt} onError={() => setLoadFailed(true)} />}
        </div>
      </section>
    </dialog>
  );
}
