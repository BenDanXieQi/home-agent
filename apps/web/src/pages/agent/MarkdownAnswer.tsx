import { memo, useDeferredValue } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        {children}
      </table>
    </div>
  ),
  img: ({ alt }) => <span className="text-muted">{alt}</span>,
} satisfies Components;

const plugins = [remarkGfm];

export const MarkdownAnswer = memo(function MarkdownAnswer({
  children,
}: {
  children: string;
}) {
  const content = useDeferredValue(children);
  return (
    <div className="min-w-0 break-words text-sm leading-7 [&_p]:my-3 [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mt-4 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li>p]:my-1 [&_li>ul]:my-1 [&_li>ol]:my-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-ink/20 [&_blockquote]:pl-4 [&_blockquote]:text-muted [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-ink/30 [&_a:hover]:decoration-ink [&_a]:break-all [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-surface [&_pre]:p-4 [&_pre]:leading-6 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs [&_hr]:my-5 [&_hr]:border-ink/10 [&_th]:border [&_th]:border-ink/10 [&_th]:bg-surface [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:border-ink/10 [&_td]:px-3 [&_td]:py-2 [&_input]:mr-2 [&_.contains-task-list]:list-none [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <Markdown remarkPlugins={plugins} skipHtml components={components}>
        {content}
      </Markdown>
    </div>
  );
});
