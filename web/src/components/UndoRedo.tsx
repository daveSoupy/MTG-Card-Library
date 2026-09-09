/** The deck builder's and collection's undo/redo pair — visible at every width,
 *  not a hover affordance or a long-press. */
export function UndoRedo({
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  busy,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  busy: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="undo-redo">
      <button
        className="btn secondary"
        disabled={!canUndo || busy}
        onClick={onUndo}
        title={`${undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo'} · ⌘Z`}
        aria-label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
      >
        ↶<span className="undo-word"> Undo</span>
      </button>
      <button
        className="btn secondary"
        disabled={!canRedo || busy}
        onClick={onRedo}
        title={`${redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo'} · ⌘⇧Z`}
        aria-label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
      >
        ↷<span className="undo-word"> Redo</span>
      </button>
    </div>
  );
}
