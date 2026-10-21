import { useRef, type RefObject } from "react";
import { AnimatePresence, m } from "motion/react";
import { ImagePlus, X } from "lucide-react";
import { Button } from "../../../components/Button";
import { ImageFileInput } from "../../../components/ImageUpload";
import { ImageThumbnail, type PlanningImage } from "./ImageViewer";
import { planningImageLimit as imageLimit } from "../../../modules/spatial/planning";

export function Composer({
  started,
  images,
  text,
  disabled,
  reading,
  sending,
  viewing,
  picker,
  onText,
  onAdd,
  onRemove,
  onView,
  onSend,
  onStop,
}: {
  started: boolean;
  images: PlanningImage[];
  text: string;
  disabled: boolean;
  reading: boolean;
  sending: boolean;
  viewing: string | null;
  picker: RefObject<HTMLInputElement | null>;
  onText: (text: string) => void;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onView: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const full = images.length >= imageLimit;
  // The first round needs a floor plan; later rounds accept text alone.
  const ready = started
    ? !!text.trim() || images.length > 0
    : images.length > 0;
  const hint = started
    ? "回答问题，或告诉 AI 要调整哪里"
    : images.length
      ? "补充说明（可选），例如：这是二楼；主卧带独立卫生间；阳台不用登记"
      : "先添加户型图，再补充说明";
  return (
    <form
      className="grid shrink-0 gap-2 rounded-2xl bg-surface p-2 focus-within:ring-2 focus-within:ring-ink/15"
      aria-label={started ? "继续调整" : "开始 AI 分析"}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !disabled) onSend();
      }}
    >
      <ImageFileInput
        ref={picker}
        disabled={disabled || full}
        label="添加户型图"
        onFiles={(files) => {
          onAdd(files);
          field.current?.focus();
        }}
      />
      <AnimatePresence initial={false}>
        {images.length ? (
          <m.ul
            key="images"
            className="flex flex-wrap gap-2 px-1 pt-1"
            aria-label="待发送的图片"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            {images.map((image) => (
              <li key={image.id} className="relative">
                <ImageThumbnail
                  image={image}
                  open={viewing === image.id}
                  label={`放大查看 ${image.name}`}
                  onOpen={() => onView(image.id)}
                  className="size-16"
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onRemove(image.id)}
                  aria-label={`移除 ${image.name}`}
                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink text-white hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1 disabled:hidden"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </m.ul>
        ) : null}
      </AnimatePresence>
      <label className="sr-only" htmlFor="spatial-planning-text">
        {started ? "回复或补充说明" : "补充说明"}
      </label>
      <textarea
        id="spatial-planning-text"
        ref={field}
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={hint}
        onChange={(event) => onText(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!files.length) return;
          event.preventDefault();
          onAdd(files);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (ready && !disabled) onSend();
          }
        }}
        className="max-h-40 min-h-11 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none [field-sizing:content] placeholder:text-muted disabled:opacity-60"
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="small"
          variant="ghost"
          icon={<ImagePlus size={16} aria-hidden="true" />}
          disabled={disabled || full || reading}
          status={reading ? "pending" : "idle"}
          onClick={() => picker.current?.click()}
        >
          {full ? `已满 ${imageLimit} 张` : "添加图片"}
        </Button>
        <span className="hidden text-xs text-muted sm:inline">
          支持拖入或粘贴 · ⌘/Ctrl + Enter 发送
        </span>
        <Button
          type="submit"
          size="small"
          variant="primary"
          className="ml-auto"
          status={sending ? "pending" : "idle"}
          pendingAction={{ label: "停止", onClick: onStop }}
          disabled={!sending && (disabled || !ready)}
        >
          {started ? "发送" : "开始分析"}
        </Button>
      </div>
    </form>
  );
}
