import { useEffect, type ReactNode } from 'react';

/**
 * The shell every in-app reference panel renders into: a backdrop, a centred
 * card, a header with a Close button, and dismissal on Escape or a backdrop
 * click. Pulled out of SyntaxHelp (Phase 17) so the search reference and the
 * six `?` panels beside dense controls all look and behave the same way.
 *
 * A section is either a two-column list of `entries` (syntax on the left, what
 * it means on the right — SyntaxHelp's shape) or plain `body` prose. Panels
 * mix the two freely.
 */

export interface HelpEntry {
  syntax: string;
  meaning: string;
}

export interface HelpSection {
  title: string;
  entries?: HelpEntry[];
  body?: ReactNode;
}

/** One reference panel's content, as helpTopics.tsx registers it. */
export interface HelpTopic {
  title: string;
  /** One line for the index, and under the title when the panel opens. */
  intro: string;
  sections: HelpSection[];
  /** Prose panels read better in one column; the syntax table wants two. */
  columns?: 1 | 2;
}

export function HelpPanel({
  title,
  intro,
  sections,
  children,
  onClose,
  onBack,
  className,
}: {
  title: string;
  /** One line under the title, before the sections. */
  intro?: ReactNode;
  sections?: HelpSection[];
  /** Anything after the sections — the welcome's page links, the index's list. */
  children?: ReactNode;
  onClose: () => void;
  /** Present when opened from the help index: a way back to the list. */
  onBack?: () => void;
  className?: string;
}) {
  useEffect(() => {
    // Capture phase, and stop the event there: a panel opened over another
    // overlay (the import dialogs listen for Escape too) must close alone,
    // not take the dialog underneath with it. Stopping propagation during
    // capture skips every later listener in the dispatch, bubble included.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="sync-overlay help-overlay" onClick={onClose}>
      <div
        className={`syntax-card${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="syntax-head">
          <h2>{title}</h2>
          <span className="btnrow">
            {onBack && <button className="btn secondary" onClick={onBack}>All topics</button>}
            <button className="btn secondary" onClick={onClose}>Close</button>
          </span>
        </div>
        {intro && <p className="note">{intro}</p>}

        {sections && sections.length > 0 && (
          <div className="syntax-body">
            {sections.map((section) => (
              <section key={section.title}>
                <h3>{section.title}</h3>
                {section.entries?.map((entry) => (
                  <div className="syntax-row" key={entry.syntax}>
                    <code>{entry.syntax}</code>
                    <span>{entry.meaning}</span>
                  </div>
                ))}
                {section.body && <div className="help-prose">{section.body}</div>}
              </section>
            ))}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}
