import Image from "next/image";
import { useEffect, useState } from "react";

import {
  emojiGroups,
  kaomojiGroups,
  stickerGroups,
  type StickerItem,
} from "@/src/emoji/expressionCatalog";

type PickerTab = "emoji" | "kaomoji" | "stickers";

type ExpressionPickerProps = {
  open: boolean;
  onClose: () => void;
  onInsertText: (value: string) => void;
  onSendSticker: (src: string, label: string) => Promise<boolean>;
};

const tabs: Array<{ id: PickerTab; label: string }> = [
  { id: "emoji", label: "表情" },
  { id: "kaomoji", label: "颜文字" },
  { id: "stickers", label: "表情包" },
];

export function ExpressionPicker({
  open,
  onClose,
  onInsertText,
  onSendSticker,
}: ExpressionPickerProps) {
  const [tab, setTab] = useState<PickerTab>("emoji");
  const [categoryByTab, setCategoryByTab] = useState<Record<PickerTab, string>>({
    emoji: emojiGroups[0].id,
    kaomoji: kaomojiGroups[0].id,
    stickers: stickerGroups[0].id,
  });
  const [query, setQuery] = useState("");
  const [sendingSticker, setSendingSticker] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  if (!open) return null;

  const textGroups = tab === "emoji" ? emojiGroups : kaomojiGroups;
  const activeGroups = tab === "stickers" ? stickerGroups : textGroups;
  const activeCategory = categoryByTab[tab];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const textItems = tab === "stickers"
    ? []
    : normalizedQuery
      ? textGroups.flatMap((group) => group.label.includes(normalizedQuery) || group.id.includes(normalizedQuery)
        ? group.items
        : group.items.filter((item) => item.includes(normalizedQuery)))
      : textGroups.find((group) => group.id === activeCategory)?.items ?? [];
  const stickerItems = tab === "stickers"
    ? normalizedQuery
      ? stickerGroups.flatMap((group) => group.label.includes(normalizedQuery) || group.id.includes(normalizedQuery)
        ? group.items
        : group.items.filter((item) => item.label.includes(normalizedQuery)))
      : stickerGroups.find((group) => group.id === activeCategory)?.items ?? []
    : [];

  const selectTab = (nextTab: PickerTab) => {
    setTab(nextTab);
    setQuery("");
  };

  const sendSticker = async (sticker: StickerItem) => {
    setSendingSticker(sticker.id);
    try {
      if (await onSendSticker(sticker.src, sticker.label)) onClose();
    } finally {
      setSendingSticker("");
    }
  };

  return (
    <section className="expression-picker" id="expression-picker" role="dialog" aria-label="表情选择器">
      <header className="expression-picker-header">
        <strong>表达</strong>
        <button type="button" onClick={onClose} aria-label="关闭表情选择器">×</button>
      </header>

      <div className="expression-tabs" role="tablist" aria-label="表达类型">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => selectTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <input
        className="expression-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
          if (event.key === "Escape") onClose();
        }}
        placeholder={tab === "stickers" ? "搜索表情包" : "搜索分类或字符"}
        aria-label="搜索表达内容"
      />

      <nav className="expression-categories" aria-label={`${tabs.find((item) => item.id === tab)?.label}分类`}>
        {activeGroups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={activeCategory === group.id && !normalizedQuery ? "active" : ""}
            onClick={() => {
              setCategoryByTab((current) => ({ ...current, [tab]: group.id }));
              setQuery("");
            }}
            aria-pressed={activeCategory === group.id && !normalizedQuery}
          >
            <span aria-hidden>{group.icon}</span>
            {group.label}
          </button>
        ))}
      </nav>

      {tab === "stickers" ? (
        <div className="sticker-grid" aria-live="polite">
          {stickerItems.map((sticker) => (
            <button
              key={sticker.id}
              type="button"
              onClick={() => void sendSticker(sticker)}
              disabled={Boolean(sendingSticker)}
              aria-label={`发送表情包：${sticker.label}`}
              title={sticker.label}
            >
              <Image src={sticker.src} width={72} height={72} alt="" loading="eager" />
              <span>{sendingSticker === sticker.id ? "发送中…" : sticker.label}</span>
            </button>
          ))}
          {!stickerItems.length ? <p className="expression-empty">没有找到匹配的表情包</p> : null}
        </div>
      ) : (
        <div className={`expression-grid ${tab === "kaomoji" ? "kaomoji-grid" : "emoji-grid"}`} aria-live="polite">
          {textItems.map((value, index) => (
            <button
              key={`${value}-${index}`}
              type="button"
              onClick={() => onInsertText(value)}
              aria-label={`插入 ${value}`}
              title={`插入 ${value}`}
            >
              {value}
            </button>
          ))}
          {!textItems.length ? <p className="expression-empty">没有找到匹配内容</p> : null}
        </div>
      )}

      <footer className="expression-picker-footer">
        Win + .、Fn/🌐 等系统面板可直接输入；应用快捷键为 Ctrl/⌘ + Shift + 空格
      </footer>
    </section>
  );
}
