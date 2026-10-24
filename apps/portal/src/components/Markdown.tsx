import { Fragment, type ReactNode } from "react";
import { useNav, useRun } from "../lib/context";

// Small, safe Markdown subset for model-written report text: paragraphs,
// bullet/numbered lists, **bold**, *italic*, and [[A:id]] / [[E:id]] citations
// that open the cited agent or evidence. No HTML is ever injected.

function Inline({ text }: { text: string }) {
  const nav = useNav();
  const { state } = useRun();
  const parts: ReactNode[] = [];
  const re = /\[\[([AE]):([^\]]+)\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      const id = m[2].trim();
      const isAgent = m[1] === "A";
      const name = isAgent ? state.personas.get(id)?.name : undefined;
      parts.push(
        <a key={i++} className="cite" title={isAgent ? `Agent ${id}` : `Evidence ${id}`} onClick={() => (isAgent ? nav.openAgent(id) : nav.openEvidence(id))}>
          {isAgent ? (name ?? id) : "src"}
        </a>,
      );
    } else if (m[3]) parts.push(<strong key={i++}>{m[3]}</strong>);
    else if (m[4]) parts.push(<em key={i++}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  return (
    <div className="prose">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const isLast = bi === blocks.length - 1;
        const caret = streaming && isLast ? <span className="caret" /> : null;
        if (lines.length && lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const items = lines.map((l, li) => (
            <li key={li}>
              <Inline text={l.replace(/^\s*([-*•]|\d+\.)\s+/, "")} />
              {li === lines.length - 1 ? caret : null}
            </li>
          ));
          return ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                <Inline text={l.replace(/^#+\s*/, "")} />
              </Fragment>
            ))}
            {caret}
          </p>
        );
      })}
    </div>
  );
}
